import { Telegraf, Markup } from "telegraf";
import { env, isOwner } from "./env.js";
import {
  getSettings,
  saveSettings,
  listChats,
  getChat,
  setHistory,
  deleteChat,
  pushHistory,
  listSessionKeys,
  readSessionKey,
  writeSessionKey,
  clearSession,
} from "./store.js";
import { wa, startWhatsApp, logoutWhatsApp } from "./whatsapp.js";

/** chatId -> { step, data } */
const flow = new Map();
const setStep = (id, step, data = {}) => flow.set(String(id), { step, data });
const getStep = (id) => flow.get(String(id)) || null;
const clearStep = (id) => flow.delete(String(id));

const statusLine = () => {
  if (wa.status === "connected") return `🟢 Connected${wa.me ? ` (+${wa.me})` : ""}`;
  if (wa.status === "pairing") return "🟡 Pairing… code bheja gaya hai";
  if (wa.status === "connecting") return "🟡 Connecting…";
  return "🔴 Disconnected";
};

let replyOn = true; // cached for menu rendering
let humanOn = true; // read-gap, mood, typos, stickers

function mainMenu() {
  const connected = wa.status === "connected";
  const rows = [
    [
      connected
        ? Markup.button.callback("✅ WhatsApp Connected", "status")
        : Markup.button.callback("🔗 Connect WhatsApp", "connect"),
    ],
    [Markup.button.callback("🧠 Prompt", "prompt"), Markup.button.callback("💬 Chat", "chats:0")],
    [Markup.button.callback("⏱ Delay", "delay"), Markup.button.callback("💾 Backup / Upload", "backup")],
    [
      Markup.button.callback("🩹 Sticker", "stk"),
      humanOn
        ? Markup.button.callback("🧍 Human: ON", "human:off")
        : Markup.button.callback("🤖 Human: OFF", "human:on"),
    ],
  ];
  rows.push([
    replyOn
      ? Markup.button.callback("🟢 Reply: ON (band karo)", "toggle:off")
      : Markup.button.callback("🔴 Reply: OFF (chalu karo)", "toggle:on"),
  ]);
  if (connected) rows.push([Markup.button.callback("🚪 Logout", "logout")]);
  rows.push([Markup.button.callback("🔄 Refresh", "home")]);
  return Markup.inlineKeyboard(rows);
}

const backBtn = (target = "home") =>
  Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", target)]]);

const homeText = () =>
  `*Priya Control Panel* 😎\n\nStatus: ${statusLine()}\nReply: ${replyOn ? "ON" : "OFF"}\nHuman mode: ${humanOn ? "ON" : "OFF"}\n\nNeeche button se sab control karo.`;

async function showHome(ctx, edit = false) {
  clearStep(ctx.chat.id);
  const s = await getSettings();
  replyOn = s.enabled !== false;
  humanOn = s.human !== false;
  const payload = [homeText(), { parse_mode: "Markdown", ...mainMenu() }];
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(...payload).catch(() => ctx.reply(...payload));
  } else {
    await ctx.reply(...payload);
  }
}

export function createBot() {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
  const bot = new Telegraf(env.BOT_TOKEN);

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id && !isOwner(id)) return ctx.reply("⛔ Ye panel private hai.");
    return next();
  });

  bot.start(async (ctx) => {
    await saveSettings({ panelChatId: ctx.chat.id });
    await showHome(ctx);
  });

  bot.action("home", async (ctx) => {
    await ctx.answerCbQuery();
    await showHome(ctx, true);
  });

  bot.action(/^toggle:(on|off)$/, async (ctx) => {
    const on = ctx.match[1] === "on";
    await saveSettings({ enabled: on });
    replyOn = on;
    await ctx.answerCbQuery(on ? "Reply ON" : "Reply OFF");
    await showHome(ctx, true);
  });

  bot.action(/^human:(on|off)$/, async (ctx) => {
    const on = ctx.match[1] === "on";
    await saveSettings({ human: on });
    humanOn = on;
    await ctx.answerCbQuery(on ? "Human mode ON" : "Human mode OFF");
    await showHome(ctx, true);
  });

  /* ------------------------------ stickers ----------------------------- */

  bot.action("stk", async (ctx) => {
    await ctx.answerCbQuery();
    const { stickers } = await getSettings();
    setStep(ctx.chat.id, "await_sticker");
    const list = stickers.length
      ? stickers.map((u, i) => `${i + 1}. ${u}`).join("\n")
      : "_koi sticker nahi hai_";
    await ctx.editMessageText(
      `🩹 *Stickers*\n\n${list}\n\nNaya sticker add karne ke liye \`.webp\` ka link bhejo (ek line me ek).\nHatane ke liye bhejo: \`del 2\`  |  sab hatao: \`clear\``,
      { parse_mode: "Markdown", ...backBtn() },
    );
  });

  bot.action("status", async (ctx) => {
    await ctx.answerCbQuery(statusLine());
  });

  /* ------------------------------ connect ------------------------------ */

  bot.action("connect", async (ctx) => {
    await ctx.answerCbQuery();
    setStep(ctx.chat.id, "await_number");
    await ctx.editMessageText(
      "📱 WhatsApp number bhejo (country code ke saath):\n\n`+91 9876543210`\n`919876543210`\n`+54 9112345678`",
      { parse_mode: "Markdown", ...backBtn() },
    );
  });

  /* ------------------------------- logout ------------------------------ */

  bot.action("logout", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "⚠️ Pakka logout karna hai? Session delete ho jayega, dobara pairing karni padegi.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Confirm", "logout:yes"),
          Markup.button.callback("❌ Cancel", "home"),
        ],
      ]),
    );
  });

  bot.action("logout:yes", async (ctx) => {
    await ctx.answerCbQuery("Logging out…");
    await logoutWhatsApp();
    await ctx.editMessageText("🚪 Logout ho gaya, session delete kar diya.", backBtn());
  });

  /* ------------------------------- prompt ------------------------------ */

  bot.action("prompt", async (ctx) => {
    await ctx.answerCbQuery();
    const { prompt } = await getSettings();
    setStep(ctx.chat.id, "await_prompt");
    const preview = prompt.length > 3200 ? `${prompt.slice(0, 3200)}…` : prompt;
    await ctx.editMessageText(
      `🧠 *Current prompt:*\n\n\`\`\`\n${preview}\n\`\`\`\n\nNaya prompt bhejo (replace ho jayega).`,
      { parse_mode: "Markdown", ...backBtn() },
    );
  });

  /* -------------------------------- delay ------------------------------ */

  bot.action("delay", async (ctx) => {
    await ctx.answerCbQuery();
    const s = await getSettings();
    setStep(ctx.chat.id, "await_delay");
    await ctx.editMessageText(
      `⏱ *Delay settings*\nReply delay: *${s.delaySec}s*\nTyping-wait: *${s.waitSec}s*\n\n` +
        "Bhejo: `5` (reply delay) ya `5 6` (reply delay + wait).",
      { parse_mode: "Markdown", ...backBtn() },
    );
  });

  /* -------------------------------- chats ------------------------------ */

  bot.action(/^chats:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const page = Number(ctx.match[1]);
    const all = await listChats();
    const perPage = 8;
    const slice = all.slice(page * perPage, page * perPage + perPage);

    if (!all.length) {
      return ctx.editMessageText("💬 Abhi koi chat save nahi hai.", backBtn());
    }

    const rows = slice.map((c, i) => [
      Markup.button.callback(
        `${c.name || c.jid.split("@")[0]} • ${c.history?.length || 0}`,
        `chat:${page * perPage + i}`,
      ),
    ]);
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback("◀️", `chats:${page - 1}`));
    if (all.length > (page + 1) * perPage) nav.push(Markup.button.callback("▶️", `chats:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([Markup.button.callback("⬅️ Back", "home")]);

    await ctx.editMessageText("💬 *Saved chats*", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(rows),
    });
  });

  const chatByIndex = async (index) => (await listChats())[index] || null;

  bot.action(/^chat:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = Number(ctx.match[1]);
    const chat = await chatByIndex(idx);
    if (!chat) return ctx.editMessageText("Chat mil nahi rahi.", backBtn("chats:0"));

    const lines = (chat.history || [])
      .slice(-15)
      .map((h) => `${h.role === "user" ? "👤" : "👧"} ${h.text}`)
      .join("\n");

    await ctx.editMessageText(
      `👤 *${chat.name || chat.jid.split("@")[0]}*\n\n${lines || "_khali_"}`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("✏️ Edit", `chat:edit:${idx}`),
            Markup.button.callback("➕ Add", `chat:add:${idx}`),
          ],
          [Markup.button.callback("🗑 Delete", `chat:del:${idx}`)],
          [Markup.button.callback("⬅️ Back", "chats:0")],
        ]),
      },
    );
  });

  bot.action(/^chat:edit:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = Number(ctx.match[1]);
    setStep(ctx.chat.id, "await_chat_edit", { idx });
    await ctx.editMessageText(
      "✏️ Poori chat replace karo. Har line: `user: text` ya `bot: text`",
      { parse_mode: "Markdown", ...backBtn(`chat:${idx}`) },
    );
  });

  bot.action(/^chat:add:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = Number(ctx.match[1]);
    setStep(ctx.chat.id, "await_chat_add", { idx });
    await ctx.editMessageText("➕ Nayi line bhejo: `user: text` ya `bot: text`", {
      parse_mode: "Markdown",
      ...backBtn(`chat:${idx}`),
    });
  });

  bot.action(/^chat:del:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = Number(ctx.match[1]);
    await ctx.editMessageText(
      "⚠️ Ye chat delete karni hai?",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Confirm", `chat:del:yes:${idx}`),
          Markup.button.callback("❌ Cancel", `chat:${idx}`),
        ],
      ]),
    );
  });

  bot.action(/^chat:del:yes:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const chat = await chatByIndex(Number(ctx.match[1]));
    if (chat) await deleteChat(chat.jid);
    await ctx.editMessageText("🗑 Chat delete ho gayi.", backBtn("chats:0"));
  });

  /* ------------------------------- backup ------------------------------ */

  bot.action("backup", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "💾 *Backup / Upload*\n\nDownload = session file Telegram me aayegi.\nUpload = mujhe wahi `.json` file bhej do.",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬇️ Download session", "backup:down")],
          [Markup.button.callback("⬆️ Upload session", "backup:up")],
          [Markup.button.callback("⬅️ Back", "home")],
        ]),
      },
    );
  });

  bot.action("backup:down", async (ctx) => {
    await ctx.answerCbQuery("Bana raha hu…");
    const ids = await listSessionKeys();
    if (!ids.length) return ctx.reply("❌ Koi session save nahi hai.");
    const dump = {};
    for (const id of ids) dump[id] = await readSessionKey(id);
    const buffer = Buffer.from(JSON.stringify({ session: dump }, null, 2));
    await ctx.replyWithDocument({ source: buffer, filename: `wa-session-${Date.now()}.json` });
  });

  bot.action("backup:up", async (ctx) => {
    await ctx.answerCbQuery();
    setStep(ctx.chat.id, "await_session_file");
    await ctx.editMessageText("⬆️ Session `.json` file bhej do.", {
      parse_mode: "Markdown",
      ...backBtn("backup"),
    });
  });

  bot.on("document", async (ctx) => {
    const step = getStep(ctx.chat.id);
    if (step?.step !== "await_session_file") return;
    try {
      const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      const json = await fetch(link.href).then((r) => r.json());
      const session = json.session || json;
      await clearSession();
      for (const [id, value] of Object.entries(session)) await writeSessionKey(id, value);
      clearStep(ctx.chat.id);
      await ctx.reply("✅ Session restore ho gaya. Connect kar raha hu…");
      startWhatsApp().catch((e) => ctx.reply(`❌ ${e.message}`));
    } catch (e) {
      await ctx.reply(`❌ File padh nahi paya: ${e.message}`);
    }
  });

  /* ------------------------------- text in ----------------------------- */

  bot.on("text", async (ctx) => {
    const step = getStep(ctx.chat.id);
    const text = ctx.message.text.trim();
    if (!step) return showHome(ctx);

    if (step.step === "await_number") {
      const number = text.replace(/[^0-9]/g, "");
      if (number.length < 8) return ctx.reply("❌ Number theek nahi lagta, phir se bhejo.");
      clearStep(ctx.chat.id);
      await ctx.reply("⏳ Pairing code bana raha hu…");
      try {
        await startWhatsApp({ phoneNumber: number });
      } catch (e) {
        await ctx.reply(`❌ ${e.message}`, mainMenu());
      }
      return;
    }

    if (step.step === "await_sticker") {
      const cur = (await getSettings()).stickers;
      if (/^clear$/i.test(text)) {
        await saveSettings({ stickers: [] });
        clearStep(ctx.chat.id);
        return ctx.reply("✅ Saare stickers hata diye.", mainMenu());
      }
      const del = text.match(/^del\s+(\d+)$/i);
      if (del) {
        const idx = Number(del[1]) - 1;
        const next = cur.filter((_, i) => i !== idx);
        await saveSettings({ stickers: next });
        clearStep(ctx.chat.id);
        return ctx.reply(`✅ Sticker hata diya (${next.length} bache).`, mainMenu());
      }
      const urls = text
        .split(/\s+/)
        .filter((u) => /^https?:\/\/\S+$/i.test(u));
      if (!urls.length) return ctx.reply("❌ Sticker ka link (https://...webp) bhejo.");
      const next = [...new Set([...cur, ...urls])].slice(0, 30);
      await saveSettings({ stickers: next });
      clearStep(ctx.chat.id);
      return ctx.reply(`✅ Sticker add ho gaya (total ${next.length}).`, mainMenu());
    }

    if (step.step === "await_prompt") {
      await saveSettings({ prompt: text });
      clearStep(ctx.chat.id);
      return ctx.reply("✅ Prompt save ho gaya.", mainMenu());
    }

    if (step.step === "await_delay") {
      const nums = text.match(/\d+/g)?.map(Number) || [];
      if (!nums.length) return ctx.reply("❌ Number bhejo jaise `5` ya `5 6`.");
      await saveSettings({ delaySec: nums[0], waitSec: nums[1] ?? undefined });
      clearStep(ctx.chat.id);
      return ctx.reply(`✅ Delay set: ${nums[0]}s${nums[1] ? `, wait ${nums[1]}s` : ""}`, mainMenu());
    }

    if (step.step === "await_chat_edit" || step.step === "await_chat_add") {
      const chat = (await listChats())[step.data.idx];
      if (!chat) {
        clearStep(ctx.chat.id);
        return ctx.reply("❌ Chat mil nahi rahi.", mainMenu());
      }
      const parse = (line) => {
        const m = line.match(/^(user|bot)\s*:\s*(.+)$/i);
        return m ? { role: m[1].toLowerCase(), text: m[2].trim(), at: Date.now() } : null;
      };
      const entries = text.split("\n").map(parse).filter(Boolean);
      if (!entries.length) return ctx.reply("❌ Format: `user: hello`");

      if (step.step === "await_chat_edit") await setHistory(chat.jid, entries);
      else await pushHistory(chat.jid, entries);

      clearStep(ctx.chat.id);
      return ctx.reply("✅ Chat update ho gayi.", mainMenu());
    }

    return showHome(ctx);
  });

  /* ------------------------ whatsapp -> telegram ----------------------- */

  wa.onEvent = async (type, payload) => {
    const { panelChatId } = await getSettings();
    if (!panelChatId) return;
    const send = (msg, extra) =>
      bot.telegram.sendMessage(panelChatId, msg, { parse_mode: "Markdown", ...extra }).catch(() => {});

    if (type === "pairing") {
      return send(
        `🔗 *Pairing code:*\n\n\`${payload.code}\`\n\nWhatsApp > Linked devices > Link with phone number > ye code daalo.`,
        backBtn(),
      );
    }
    if (type === "connected") return send(`✅ WhatsApp connected +${payload.me}`, mainMenu());
    if (type === "logged_out") return send("⚠️ WhatsApp se logout ho gaya.", mainMenu());
    if (type === "reconnecting") return send("🔄 Reconnecting…");
    if (type === "error") return send(`❌ ${payload.message}`);
  };

  return bot;
}
