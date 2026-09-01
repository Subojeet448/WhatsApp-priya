// All runtime configuration comes from Render environment variables.
export const env = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  // Base64 of the Firebase service-account JSON file
  FIREBASE_SDK_BASE64: process.env.FIREBASE_SDK_BASE64 || process.env.FIREBASE_JSON_BASE64 || "",
  // Optional: restrict the Telegram panel to these numeric user ids (comma separated)
  OWNER_IDS: (process.env.OWNER_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
  // AI endpoint (multi purpose: text, image generate, image understand/enhance)
  AI_URL: process.env.AI_URL || "https://gpt5-9oce.onrender.com/ask",
  AI_PROMPT_PARAM: process.env.AI_PROMPT_PARAM || "prompt",
  AI_IMAGE_PARAM: process.env.AI_IMAGE_PARAM || "image",
  PORT: Number(process.env.PORT || 3000),
};

export function isOwner(id) {
  if (env.OWNER_IDS.length === 0) return true;
  return env.OWNER_IDS.includes(String(id));
}
