/** Helpers that make the bot feel like a real person typing on WhatsApp. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
export const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Reading/thinking pause before the first reply. Sometimes fast, sometimes slow. */
export function thinkDelay(baseSec) {
  const base = Math.max(0, baseSec) * 1000;
  if (chance(0.15)) return base * 0.4 + rand(300, 900); // quick, was already on chat
  if (chance(0.15)) return base + rand(6000, 14000); // got distracted
  return base + rand(800, 3500);
}

/** Typing time roughly proportional to message length, with human variance. */
export function typingDelay(text) {
  const len = String(text || "").length;
  const perChar = rand(45, 110); // fast-ish thumb typing
  let ms = 500 + len * perChar;
  if (chance(0.18)) ms += rand(1200, 4000); // paused mid-typing
  return Math.min(16000, Math.max(400, ms));
}

/** Small gap between two consecutive messages of the same burst. */
export function betweenDelay() {
  if (chance(0.25)) return rand(200, 600);
  if (chance(0.15)) return rand(2500, 6000);
  return rand(700, 2000);
}

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/** Keeps at most one emoji in the whole reply, and often none at all. */
function thinEmoji(parts) {
  const keepOne = chance(0.35);
  let kept = false;
  return parts.map((p) => {
    let out = p;
    const found = out.match(EMOJI_RE);
    out = out
      .replace(EMOJI_RE, "")
      .replace(/\s+([.,!?…])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (keepOne && !kept && found && found.length && out) {
      kept = true;
      out = `${out} ${found[0]}`.trim();
    }
    return out;
  });
}

/** Real people drop capitals/full stops and use small symbols instead. */
function casualize(line, isLast) {
  let out = line;

  // mostly lowercase start, sometimes not
  if (chance(0.75)) out = out.charAt(0).toLowerCase() + out.slice(1);

  // lowercase after a full stop / question mark too, like lazy phone typing
  out = out.replace(/([.!?]\s+)([A-Z])/g, (m, a, b) => (chance(0.8) ? a + b.toLowerCase() : m));

  // drop some inner full stops
  if (chance(0.5)) out = out.replace(/\.\s+/g, " ");

  // drop the trailing full stop most of the time
  if (chance(0.85)) out = out.replace(/\.$/, "");

  // shorten common words sometimes
  if (chance(0.3)) out = out.replace(/\byou\b/gi, "u").replace(/\bare\b/gi, "r");
  if (chance(0.25)) out = out.replace(/\bnahin\b/gi, "nahi").replace(/\bkyunki\b/gi, "kyuki");

  // occasional trailing symbol instead of emoji
  if (isLast && chance(0.22)) out += pick(["..", "...", " :)", " :/", " hmm", " ??", " !!"]);
  else if (chance(0.12)) out += pick(["..", "...", ""]);

  // sometimes stretch a word a bit
  if (chance(0.1)) out = out.replace(/\b(haan|arre|acha|ok|hii?)\b/i, (m) => m + m.slice(-1).repeat(rand(1, 3)));

  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Splits an AI answer into WhatsApp style chunks with a random shape:
 * sometimes 1 message, sometimes 2-3, sometimes 4-5 tiny ones.
 */
export function splitMessages(text) {
  const cleaned = String(text || "")
    .replace(/\*\*/g, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^(priya|bot|me)\s*:\s*/gim, "")
    .trim();
  if (!cleaned) return [];

  // Break into the smallest natural units first.
  const units = [];
  for (const line of cleaned.split(/\n+/)) {
    const l = line.trim();
    if (!l) continue;
    const sentences = l.match(/[^.!?…]+[.!?…]*/g) || [l];
    for (const s of sentences) {
      const t = s.trim();
      if (t) units.push(t);
    }
  }
  if (!units.length) return [];

  // Decide the shape of this reply burst.
  const r = Math.random();
  let target;
  if (r < 0.3) target = 1;
  else if (r < 0.6) target = 2;
  else if (r < 0.82) target = 3;
  else if (r < 0.94) target = 4;
  else target = 5;
  target = Math.min(target, units.length);

  // Group units into `target` chunks, keeping chunk sizes uneven.
  const chunks = [];
  let i = 0;
  for (let c = 0; c < target; c++) {
    const remainingChunks = target - c;
    const remainingUnits = units.length - i;
    const maxTake = remainingUnits - (remainingChunks - 1);
    const take = c === target - 1 ? remainingUnits : rand(1, Math.max(2, Math.min(maxTake, 3) + 1));
    chunks.push(units.slice(i, i + take).join(" ").trim());
    i += take;
    if (i >= units.length) break;
  }

  // Hard-cap very long chunks so nothing looks like a paragraph.
  const capped = [];
  for (const ch of chunks) {
    if (ch.length <= 220) {
      capped.push(ch);
      continue;
    }
    const words = ch.split(" ");
    let buf = "";
    for (const w of words) {
      if ((buf + " " + w).trim().length > 180) {
        capped.push(buf.trim());
        buf = w;
      } else buf = `${buf} ${w}`.trim();
    }
    if (buf) capped.push(buf.trim());
  }

  let out = thinEmoji(capped).filter(Boolean);
  out = out.map((l, idx) => casualize(l, idx === out.length - 1)).filter(Boolean);
  return out.slice(0, 5);
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

/* --------------------------- read time & rhythm --------------------------- */

/** IST hour right now (0-23). */
export function istHour() {
  return Number(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }),
  );
}

/**
 * How long she takes to *read* before she even starts typing.
 * Long message or long gap -> she reads slowly. Short message in an active
 * chat -> almost instant.
 */
export function readDelay(messages, lastAt) {
  const len = (Array.isArray(messages) ? messages.join(" ") : String(messages || "")).length;
  const gapMin = lastAt ? (Date.now() - lastAt) / 60000 : 99999;

  let ms;
  if (len < 25) ms = rand(500, 2500);
  else if (len < 90) ms = rand(2000, 7000);
  else if (len < 220) ms = rand(6000, 15000);
  else ms = rand(12000, 28000);

  if (gapMin < 2) ms = Math.round(ms * 0.45); // she is right there on the chat
  else if (gapMin < 15) ms = Math.round(ms * 0.8);
  else if (gapMin > 720) ms += rand(4000, 20000); // was away, opens chat late

  if (chance(0.12)) ms += rand(15000, 60000); // put phone down for a bit
  return Math.max(300, ms);
}

/**
 * Daily rhythm: night = mostly asleep, morning/evening = active.
 * Returns { skip, extra, note }.
 */
export function rhythm() {
  const h = istHour();
  if (h >= 1 && h < 6)
    return {
      skip: chance(0.8),
      extra: rand(45000, 180000),
      note: "It is late night in India and you were sleeping, so you are sleepy and replying late.",
    };
  if (h >= 6 && h < 9)
    return {
      skip: chance(0.08),
      extra: rand(8000, 60000),
      note: "It is early morning, you just woke up / getting ready.",
    };
  if (h >= 10 && h < 14)
    return { skip: chance(0.12), extra: rand(10000, 90000), note: "It is day time, you are a bit busy with class/work at home." };
  if (h >= 22 || h < 1)
    return { skip: chance(0.05), extra: rand(5000, 30000), note: "It is night, you are on bed with the phone." };
  return { skip: false, extra: rand(0, 12000), note: "" };
}

const MOODS = [
  ["khush", "You are in a good happy mood today, a bit playful."],
  ["normal", "Your mood is normal today."],
  ["bore", "You are feeling bored today, replies a bit dry and short."],
  ["chidchidi", "You are slightly irritated today, short replies, little attitude."],
  ["udas", "You are feeling a little low/emotional today, softer replies."],
];

/** Picks a mood for the day (stable per day per chat). */
export function pickMood() {
  const r = Math.random();
  if (r < 0.4) return MOODS[1];
  if (r < 0.62) return MOODS[0];
  if (r < 0.78) return MOODS[2];
  if (r < 0.9) return MOODS[3];
  return MOODS[4];
}

export function moodNote(mood) {
  const found = MOODS.find((m) => m[0] === mood);
  return found ? found[1] : "";
}

export function dayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/* ------------------------------- typos ---------------------------------- */

const NEAR = {
  a: "sq", b: "vn", c: "xv", d: "sf", e: "wr", g: "fh", h: "gj", i: "uo",
  j: "hk", k: "jl", l: "k", m: "n", n: "bm", o: "ip", p: "o", r: "et",
  s: "ad", t: "ry", u: "yi", v: "cb", w: "qe", y: "tu",
};

function typoWord(w) {
  if (w.length < 4) return w;
  const i = rand(1, w.length - 1);
  const ch = w[i].toLowerCase();
  const mode = Math.random();
  if (mode < 0.4 && NEAR[ch]) return w.slice(0, i) + pick(NEAR[ch].split("")) + w.slice(i + 1);
  if (mode < 0.7) return w.slice(0, i) + w.slice(i + 1); // missed a letter
  return w.slice(0, i) + w[i] + w[i] + w.slice(i + 1); // double tap
}

/**
 * Sometimes makes a typo in one message and sends a "*correct" fix right after,
 * exactly like people do on WhatsApp.
 */
export function applyTypos(parts) {
  if (!parts.length || !chance(0.22)) return parts;
  const out = [...parts];
  const idx = rand(0, out.length);
  const words = out[idx].split(" ").filter((w) => /^[a-z]{4,}$/i.test(w));
  if (!words.length) return out;
  const word = pick(words);
  const bad = typoWord(word);
  if (bad === word) return out;
  out[idx] = out[idx].replace(word, bad);
  // correction either right after that line, or at the very end
  const at = chance(0.7) ? idx + 1 : out.length;
  out.splice(at, 0, `${chance(0.5) ? "*" : ""}${word}${chance(0.3) ? "*" : ""}`.trim());
  return out.slice(0, 6);
}

/** Should she quote the message she is replying to? Rare, like real people. */
export const shouldQuote = () => chance(0.15);

/** Should she drop a sticker with this reply? */
export const shouldSticker = () => chance(0.14);
