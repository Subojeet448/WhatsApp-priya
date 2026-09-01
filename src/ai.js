import { env } from "./env.js";

function buildUrl(prompt, imageUrl) {
  const url = new URL(env.AI_URL);
  url.searchParams.set(env.AI_PROMPT_PARAM, prompt);
  if (imageUrl) url.searchParams.set(env.AI_IMAGE_PARAM, imageUrl);
  return url.toString();
}

function pickText(payload) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  return (
    payload.response ||
    payload.answer ||
    payload.reply ||
    payload.result ||
    payload.text ||
    payload.message ||
    payload.output ||
    payload.data?.response ||
    ""
  );
}

const IMG_RE = /https?:\/\/\S+?\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/i;

/**
 * Calls the multi-purpose AI endpoint. Returns { text, imageUrl }.
 * imageUrl is set when the endpoint answered with a generated/enhanced image.
 */
export async function askAI(prompt, imageUrl) {
  const url = buildUrl(prompt, imageUrl);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`AI ${res.status}: ${raw.slice(0, 200)}`);
  }

  let payload = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    /* plain text answer */
  }

  let text = String(pickText(payload) || "").trim();
  let outImage =
    (typeof payload === "object" && (payload.image || payload.image_url || payload.url)) || null;

  if (!outImage) {
    const found = text.match(IMG_RE);
    if (found) {
      outImage = found[0];
      text = text.replace(found[0], "").trim();
    }
  }

  return { text, imageUrl: outImage || null };
}
