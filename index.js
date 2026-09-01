import express from "express";
import { env } from "./src/env.js";
import { initStore, listSessionKeys } from "./src/store.js";
import { createBot } from "./src/telegram.js";
import { startWhatsApp, wa } from "./src/whatsapp.js";

initStore();

const bot = createBot();
bot.launch({ dropPendingUpdates: true });
console.log("[telegram] panel running");

// Auto-resume WhatsApp if a session already exists (no repeated pairing).
listSessionKeys()
  .then((ids) => {
    if (ids.includes("creds")) {
      console.log("[whatsapp] session found, resuming…");
      return startWhatsApp();
    }
    console.log("[whatsapp] no session, waiting for Telegram pairing");
  })
  .catch((e) => console.error("[whatsapp] resume failed:", e.message));

// Render needs an open HTTP port + a health endpoint for keep-alive pings.
const app = express();
app.get("/", (_req, res) => res.json({ ok: true, whatsapp: wa.status }));
app.get("/health", (_req, res) => res.send("ok"));
app.listen(env.PORT, () => console.log(`[http] listening on ${env.PORT}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
