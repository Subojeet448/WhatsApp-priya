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
import {
  sleep,
  thinkDelay,
  typingDelay,
  splitMessages,
  gapInfo,
  betweenDelay,
  readDelay,
  rhythm,
  pickMood,
  moodNote,
  dayKey,
  applyTypos,
  shouldQuote,
  shouldSticker,
  chance,
} from "./humanize.js";

const logger = pino({ level: "silent" });

/** Runtime state shared with the Telegram panel. */
export const wa = {
  sock: null,
  status: "disconnected", // disconnected | pairing | connected
  me: null,
  pairingCode: null,
  starting: false,
  announced: false,
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
      const first = !wa.announced;
      wa.announced = true;
      if (first) notify("connected", { me: wa.me });
    }

    if (connection === "close") {
      wa.starting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        wa.status = "disconnected";
        wa.sock = null;
        await auth.clear();
        wa.announced = false;
        notify("logged_out", {});
        return;
      }
      wa.status = "disconnected";
      // silent reconnect: no Telegram spam for the 50 reconnects a day
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
  wa.announced = false;
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
  buf.lastAt = Date.now();

  buf.lastMsg = msg;
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
      if (Date.now() - (buf.lastAt || 0) < waitMs - 300) return scheduleReply(jid);
      if (settings.enabled === false) {
        buf.texts.length = 0;
        return;
      }
      if (buf.busy) return;
      buf.busy = true;
      const messages = buf.texts.splice(0, buf.texts.length);
      buf.hasImage = false;
      try {
        if (messages.length) await replyTo(jid, messages, settings, buf.lastMsg);
      } catch (e) {
        notify("error", { message: e.message });
      } finally {
        buf.busy = false;
        if (buf.texts.length) scheduleReply(jid);
      }
    }, waitMs);
  });
}

function buildPrompt(settings, chat, messages, extra = {}) {
  const known = [
    chat.name ? `Their name: ${chat.name}` : "You don't know their name yet.",
    chat.gender ? `Their gender: ${chat.gender}` : "You don't know their gender yet.",
    gapInfo(chat.lastAt),
    extra.moodNote || "",
    extra.rhythmNote || "",
    extra.missedNote || "",
  ]
    .filter(Boolean)
    .join("\n");

  const history = chat.history
    .slice(-20)
    .map((h) => `${h.role === "user" ? "Them" : "You"}: ${h.text}`)
    .join("\n");

  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  return [
    settings.prompt,
    `\nCONTEXT\nLocal time in India: ${now}\n${known}`,
    chat.notes.length ? `\nTHINGS YOU REMEMBER ABOUT THEM\n${chat.notes.slice(-8).join("\n")}` : "",
    history ? `\nCHAT SO FAR\n${history}` : "",
    `\nTHEY JUST SENT (may be multiple short messages, answer them together as one human reply):\n${messages
      .map((m) => `- ${m}`)
      .join("\n")}`,
    `\nReply now as Priya. Only the reply text. Write it the way a real girl types on a phone: lazy small letters, short forms, barely any emoji. Length is random - sometimes 1 short line, sometimes 3-5 tiny lines. Separate lines with new lines. No labels, no quotes.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Remembers small facts from what they said, so she can bring it up later. */
function learnNotes(chat, messages) {
  const notes = [];
  const joined = messages.join(" ");
  const patterns = [
    [/\bmera naam\s+([A-Za-z]{2,15})/i, (m) => `their name is ${m[1]}`],
    [/\bmy name is\s+([A-Za-z]{2,15})/i, (m) => `their name is ${m[1]}`],
    [/\b(?:main|mai|i am|i'm)\s+([A-Za-z]{3,15})\s+(?:se|from)\b/i, (m) => `they are from ${m[1]}`],
    [/\b(\d{1,2})\s*(?:saal|years?)\b/i, (m) => `they said they are ${m[1]} years old`],
    [/\b(?:exam|paper|test)\b/i, () => "they have exams going on"],
    [/\b(?:job|office|kaam)\b/i, () => "they talked about work"],
    [/\b(?:bimar|sick|fever|bukhar)\b/i, () => "they were not feeling well"],
  ];
  for (const [re, fn] of patterns) {
    const m = joined.match(re);
    if (m) notes.push(fn(m));
  }
  if (!notes.length) return chat.notes;
  const merged = [...chat.notes];
  for (const n of notes) if (!merged.includes(n)) merged.push(n);
  return merged.slice(-20);
}

async function replyTo(jid, messages, settings, lastMsg) {
  const sock = wa.sock;
  if (!sock) return;

  const chat = await getChat(jid);
  await sock.readMessages(lastMsg?.key ? [lastMsg.key] : []).catch(() => {});
  const human = settings.human !== false;

  // Mood of the day (stable for the whole day per chat).
  let mood = chat.mood;
  const today = dayKey();
  if (!human) mood = null;
  else if (!mood || chat.moodDay !== today) {
    const picked = pickMood();
    mood = picked[0];
    await saveChat(jid, { mood, moodDay: today });
  }

  const rh = human ? rhythm() : { skip: false, extra: 0, note: "" };

  // Sometimes she just doesn't reply (sleeping / phone down). She apologises later.
  if (rh.skip || (human && chance(0.02))) {
    await saveChat(jid, { missedAt: Date.now() });
    return;
  }

  const missedNote = chat.missedAt
    ? "Last time you did not reply at all (you were asleep/busy). Say sorry about it very casually, only once."
    : "";

  const prompt = buildPrompt(settings, chat, messages, {
    moodNote: mood ? moodNote(mood) : "",
    rhythmNote: rh.note,
    missedNote,
  });

  const { text, imageUrl: outImage } = await askAI(prompt, null);
  let parts = splitMessages(text);
  if (human) parts = applyTypos(parts);
  if (!parts.length && !outImage) return;

  // Read the message first (seen), then think, then start typing.
  if (human) await sleep(readDelay(messages, chat.lastAt) + rh.extra);
  await sleep(thinkDelay(settings.delaySec));

  const stickers = Array.isArray(settings.stickers) ? settings.stickers : [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const typeMs = typingDelay(part);
    // mid-typing pause on longer lines, like a real person stopping to think
    if (human && part.length > 60 && chance(0.35)) {
      await sleep(Math.round(typeMs * 0.6));
      await sock.sendPresenceUpdate("paused", jid).catch(() => {});
      await sleep(betweenDelay());
      await sock.sendPresenceUpdate("composing", jid).catch(() => {});
      await sleep(Math.round(typeMs * 0.4));
    } else {
      await sleep(typeMs);
    }
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});

    const quote =
      i === 0 && lastMsg && human && shouldQuote() ? { quoted: lastMsg } : undefined;
    await sock.sendMessage(jid, { text: part }, quote);
    await sleep(betweenDelay());
  }

  if (stickers.length && human && shouldSticker()) {
    const url = stickers[Math.floor(Math.random() * stickers.length)];
    await sock.sendMessage(jid, { sticker: { url } }).catch(() => {});
  }

  if (outImage) {
    await sock.sendMessage(jid, { image: { url: outImage } }).catch(() => {});
  }

  await pushHistory(jid, [
    ...messages.map((m) => ({ role: "user", text: m, at: Date.now() })),
    ...parts.map((p) => ({ role: "bot", text: p, at: Date.now() })),
  ]);

  const notes = learnNotes(chat, messages);
  const patch = { missedAt: 0 };
  if (notes !== chat.notes) patch.notes = notes;
  if (!chat.name) {
    const guess = messages.join(" ").match(/(?:mera naam|my name is|naam)\s+([A-Za-z]{2,15})/i);
    if (guess) patch.name = guess[1];
  }
  await saveChat(jid, patch);
}

export async function downloadIncomingImage(msg) {
  return downloadMediaMessage(msg, "buffer", {});
}
