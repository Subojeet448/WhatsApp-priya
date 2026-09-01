# Priya — WhatsApp bot + Telegram control panel

Node.js service: WhatsApp login via **pairing code** (Baileys), full control from a
**Telegram inline-button panel**, session + chats + prompt saved in **Firebase**,
deploy on **Render**.

## Env vars (Render → Environment)

| Key | Required | Notes |
| --- | --- | --- |
| `BOT_TOKEN` | yes | Telegram bot token from @BotFather |
| `FIREBASE_SDK_BASE64` | yes | `base64 -w0 serviceAccount.json` output |
| `OWNER_IDS` | no | Comma separated Telegram user ids allowed to use the panel |
| `AI_URL` | no | Default `https://gpt5-9oce.onrender.com/ask` |
| `AI_PROMPT_PARAM` | no | Default `prompt` |
| `AI_IMAGE_PARAM` | no | Default `image` (used for image generate / enhance) |

## Deploy

1. Push the repo, on Render create a **Web Service**, root directory `bot`.
2. Build `npm install`, start `npm start`, health check `/health`.
3. Add the env vars above.

## Panel flow

`/start` → inline buttons:

- **Connect WhatsApp** → send number (`+91 9876543210`, `919876543210`, `+54 …`) → bot
  replies with a pairing code → WhatsApp → Linked devices → Link with phone number.
- **Logout** → confirm / cancel → session deleted.
- **Prompt** → shows current prompt, send a new one to replace it.
- **Chat** → list of saved chats → view / edit / add lines / delete (with confirm).
- **Delay** → `5` = 5s reply delay, `5 6` = 5s reply delay + 6s typing-wait.
- **Backup / Upload** → download session JSON to Telegram, or upload it back.
- **Back** button on every step.

Session persists in Firebase, so restarts and redeploys do not need pairing again.

## Human behaviour

- Waits `waitSec` (default 6s) after the last message; if the person is still typing
  (`composing` presence) it keeps waiting, then answers all the short messages together.
- Reads receipts, `composing` presence, typing time proportional to message length,
  answers split into 1–3 short WhatsApp-style lines.
- Handles forwarded messages, image captions, emoji mirroring, and long gaps
  ("kahan the itne din") using the stored `lastAt` timestamp.
- Persona (Priya / Sara, 15+, West Bengal, Manbazar 723131, bf = Mandal) lives in
  `src/persona.js` and can be overwritten from the Telegram **Prompt** button.
- 18+ / sex talk is refused in-character.
