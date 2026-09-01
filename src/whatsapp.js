import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { useRemoteAuthState } from "./authState.js";
import { getSettings, getChat, pushHistory, saveChat } from "./store.js";
import { askAI } from "./ai.js";
import { sleep, thinkDelay, typingDelay, splitMessages, gapInfo } from "./humanize.js";

const logger = pino({ level: "silent" });

/** Runtime state shared with the Telegram panel. */
export const wa = {
  sock: null,
  status: "disconnected", // disconnected | pairing | connected
  me: null,
  pairingCode: null,
  starting: false,
  onEvent: () => {},
};

/** jid -> { texts, imageUrl, timer, typing, busy } */
const buffers = new Map();

function notify(type, payload) {
  try {
    wa.onEvent(type, payload);
  } catch {
    /* panel not ready */
  }
}

export async function startWhatsApp({ phoneNumber } = {}) {
  if (wa.starting) return wa;
  wa.starting = true;

  const auth = await useRemoteAuthState();
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    logger,
    auth: auth.state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  wa.sock = sock;
  wa.status = auth.hasSession ? "connecting" : "pairing";

  sock.ev.on("creds.update", auth.saveCreds);

  // Pairing-code login: user types the code inside WhatsApp > Linked devices.
  if (!sock.authState.creds.registered && phoneNumber) {
    const number = String(phoneNumber).replace(/[^0-9]/g, "");
    await sleep(3000);
    try {
      const code = await sock.requestPairingCode(number);
      wa.pairingCode = code?.match(/.{1,4}/g)?.join("-") || code;
      wa.status = "pairing";
      notify("pairing", { code: wa.pairingCode, number });
    } catch (e) {
      wa.starting = false;
      notify("error", { message: `Pairing failed: ${e.message}` });
      throw e;
    }
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      wa.status = "connected";
      wa.pairingCode = null;
      wa.starting = false;
      wa.me = sock.user?.id?.split(":")[0] || null;
      notify("connected", { me: wa.me });
    }

    if (connection === "close") {
      wa.starting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        wa.status = "disconnected";
        wa.sock = null;
        await auth.clear();
        notify("logged_out", {});
        return;
      }
      wa.status = "disconnected";
      notify("reconnecting", { code });
      await sleep(3000);
      startWhatsApp().catch((e) => notify("error", { message: e.message }));
    }
  });

  // Track "user is still typing" so we wait instead of cutting them off.
  sock.ev.on("presence.update", ({ id, presences }) => {
    const buf = buffers.get(id);
    if (!buf) return;
    const state = Object.values(presences || {})[0]?.lastKnownPresence;
    if (state === "composing" || state === "recording") {
      buf.typing = true;
      scheduleReply(id);
    } else {
      buf.typing = false;
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleIncoming(sock, msg);
      } catch (e) {
        notify("error", { message: e.message });
      }
    }
  });

  return wa;
}

export async function logoutWhatsApp() {
  const auth = await useRemoteAuthState();
  try {
    await wa.sock?.logout();
  } catch {
    /* already gone */
  }
  try {
    wa.sock?.end?.(undefined);
  } catch {
    /* ignore */
  }
  await auth.clear();
  wa.sock = null;
  wa.me = null;
  wa.pairingCode = null;
  wa.status = "disconnected";
  wa.starting = false;
}

function textOf(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.ephemeralMessage?.message?.conversation ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ""
  );
}

function isForwarded(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  return Boolean(ctx?.isForwarded || (ctx?.forwardingScore || 0) > 0);
}

async function handleIncoming(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return;
  if (jid === "status@broadcast" || jid.endsWith("@g.us") || jid.endsWith("@newsletter")) return;

  const body = textOf(msg).trim();
  const hasImage = Boolean(msg.message?.imageMessage);
  if (!body && !hasImage) return;

  const buf =
    buffers.get(jid) || { texts: [], timer: null, typing: false, busy: false, imageUrl: null };
  buffers.set(jid, buf);

  if (isForwarded(msg) && body) buf.texts.push(`(forwarded) ${body}`);
  else if (body) buf.texts.push(body);
  else if (hasImage) buf.texts.push("(sent a photo)");

  if (hasImage) buf.hasImage = true;

  await sock.readMessages([msg.key]).catch(() => {});
  await sock.presenceSubscribe(jid).catch(() => {});

  scheduleReply(jid);
}

/** Waits until the person stops typing/sending, then replies once. */
function scheduleReply(jid) {
  const buf = buffers.get(jid);
  if (!buf) return;
  if (buf.timer) clearTimeout(buf.timer);

  getSettings().then((settings) => {
    const waitMs = Math.max(2000, (settings.waitSec || 6) * 1000);
    buf.timer = setTimeout(async () => {
      if (buf.typing) return scheduleReply(jid); // still typing -> keep waiting
      if (buf.busy) return;
      buf.busy = true;
      const messages = buf.texts.splice(0, buf.texts.length);
      buf.hasImage = false;
      try {
        if (messages.length) await replyTo(jid, messages, settings);
      } catch (e) {
        notify("error", { message: e.message });
      } finally {
        buf.busy = false;
        if (buf.texts.length) scheduleReply(jid);
      }
    }, waitMs);
  });
}

function buildPrompt(settings, chat, messages) {
  const known = [
    chat.name ? `Their name: ${chat.name}` : "You don't know their name yet.",
    chat.gender ? `Their gender: ${chat.gender}` : "You don't know their gender yet.",
    gapInfo(chat.lastAt),
  ].join("\n");

  const history = chat.history
    .slice(-20)
    .map((h) => `${h.role === "user" ? "Them" : "You"}: ${h.text}`)
    .join("\n");

  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  return [
    settings.prompt,
    `\nCONTEXT\nLocal time in India: ${now}\n${known}`,
    history ? `\nCHAT SO FAR\n${history}` : "",
    `\nTHEY JUST SENT (may be multiple short messages, answer them together as one human reply):\n${messages
      .map((m) => `- ${m}`)
      .join("\n")}`,
    `\nReply now as Priya. Only the reply text. Use 1-3 very short lines, separated by new lines. No labels, no quotes.`,
  ].join("\n");
}

async function replyTo(jid, messages, settings) {
  const sock = wa.sock;
  if (!sock) return;

  const chat = await getChat(jid);
  const imageUrl = null; // WhatsApp media is not publicly reachable; caption is used instead
  const prompt = buildPrompt(settings, chat, messages);

  const { text, imageUrl: outImage } = await askAI(prompt, imageUrl);
  const parts = splitMessages(text);
  if (!parts.length && !outImage) return;

  await sleep(thinkDelay(settings.delaySec));

  for (const part of parts) {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await sleep(typingDelay(part));
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    await sock.sendMessage(jid, { text: part });
    await sleep(600 + Math.random() * 900);
  }

  if (outImage) {
    await sock.sendMessage(jid, { image: { url: outImage } }).catch(() => {});
  }

  await pushHistory(jid, [
    ...messages.map((m) => ({ role: "user", text: m, at: Date.now() })),
    ...parts.map((p) => ({ role: "bot", text: p, at: Date.now() })),
  ]);

  // Light-weight name/gender learning from the conversation.
  if (!chat.name) {
    const guess = messages.join(" ").match(/(?:mera naam|my name is|naam)\s+([A-Za-z]{2,15})/i);
    if (guess) await saveChat(jid, { name: guess[1] });
  }
}

export async function downloadIncomingImage(msg) {
  return downloadMediaMessage(msg, "buffer", {});
}
