/** Helpers that make the bot feel like a real girl typing on WhatsApp. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

/** Reading/thinking pause before the first reply. */
export function thinkDelay(baseSec) {
  const base = Math.max(0, baseSec) * 1000;
  return base + rand(600, 2200);
}

/** Typing time roughly proportional to message length (approx 5 chars/sec). */
export function typingDelay(text) {
  const ms = Math.min(9000, Math.max(900, text.length * rand(140, 220)));
  return ms;
}

/**
 * Splits an AI answer into small WhatsApp style chunks.
 * Keeps them short so it never looks like a paragraph reply.
 */
export function splitMessages(text) {
  const cleaned = String(text || "")
    .replace(/\*\*/g, "")
    .replace(/^[-*]\s+/gm, "")
    .trim();
  if (!cleaned) return [];

  const lines = cleaned
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parts = [];
  for (const line of lines) {
    if (line.length <= 140) {
      parts.push(line);
      continue;
    }
    const sentences = line.match(/[^.!?…]+[.!?…]*/g) || [line];
    let buf = "";
    for (const s of sentences) {
      if ((buf + " " + s).trim().length > 140) {
        if (buf) parts.push(buf.trim());
        buf = s;
      } else {
        buf = `${buf} ${s}`.trim();
      }
    }
    if (buf) parts.push(buf.trim());
  }
  return parts.slice(0, 4);
}

/** Human readable gap text used to make "kahan the itne din" reactions. */
export function gapInfo(lastAt) {
  if (!lastAt) return "This is the very first time this person is talking to you.";
  const ms = Date.now() - lastAt;
  const min = Math.floor(ms / 60000);
  if (min < 10) return "You were chatting just now.";
  if (min < 120) return `Last message was about ${min} minutes ago.`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `Last message was about ${hours} hours ago.`;
  const days = Math.floor(hours / 24);
  return `You have not talked for about ${days} day(s). React naturally about the long gap (only once).`;
}
