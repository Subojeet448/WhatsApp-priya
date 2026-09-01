import admin from "firebase-admin";
import { env } from "./env.js";
import { DEFAULT_PROMPT } from "./persona.js";

let db = null;

/** In-memory fallback so the bot still runs without Firebase configured. */
const memory = { docs: new Map() };

export function initStore() {
  if (db || !env.FIREBASE_SDK_BASE64) return db;
  try {
    const json = JSON.parse(Buffer.from(env.FIREBASE_SDK_BASE64, "base64").toString("utf8"));
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(json) });
    }
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    console.log("[store] firebase ready");
  } catch (e) {
    console.error("[store] firebase init failed, using memory store:", e.message);
  }
  return db;
}

function key(col, id) {
  return `${col}/${id}`;
}

async function getDoc(col, id) {
  if (db) {
    const snap = await db.collection(col).doc(id).get();
    return snap.exists ? snap.data() : null;
  }
  return memory.docs.get(key(col, id)) || null;
}

async function setDoc(col, id, data) {
  if (db) {
    await db.collection(col).doc(id).set(data, { merge: true });
    return;
  }
  const prev = memory.docs.get(key(col, id)) || {};
  memory.docs.set(key(col, id), { ...prev, ...data });
}

async function delDoc(col, id) {
  if (db) {
    await db.collection(col).doc(id).delete();
    return;
  }
  memory.docs.delete(key(col, id));
}

async function listDocs(col) {
  if (db) {
    const snap = await db.collection(col).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return [...memory.docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`))
    .map(([k, v]) => ({ id: k.slice(col.length + 1), ...v }));
}

/* ------------------------------ settings ------------------------------ */

const SETTINGS = { col: "botConfig", id: "settings" };

export async function getSettings() {
  const data = (await getDoc(SETTINGS.col, SETTINGS.id)) || {};
  return {
    prompt: data.prompt || DEFAULT_PROMPT,
    delaySec: typeof data.delaySec === "number" ? data.delaySec : 5,
    waitSec: typeof data.waitSec === "number" ? data.waitSec : 6,
    panelChatId: data.panelChatId || null,
    ...data,
  };
}

export async function saveSettings(patch) {
  await setDoc(SETTINGS.col, SETTINGS.id, patch);
}

/* -------------------------------- chats ------------------------------- */

const CHATS = "waChats";
const chatId = (jid) => jid.replace(/[^\w.@-]/g, "_");

export async function getChat(jid) {
  const data = (await getDoc(CHATS, chatId(jid))) || {};
  return {
    jid,
    name: data.name || null,
    gender: data.gender || null,
    lastAt: data.lastAt || 0,
    history: Array.isArray(data.history) ? data.history : [],
  };
}

export async function saveChat(jid, patch) {
  await setDoc(CHATS, chatId(jid), { jid, ...patch });
}

export async function pushHistory(jid, entries, limit = 60) {
  const chat = await getChat(jid);
  const history = [...chat.history, ...entries].slice(-limit);
  await saveChat(jid, { history, lastAt: Date.now() });
  return history;
}

export async function setHistory(jid, history) {
  await saveChat(jid, { history });
}

export async function deleteChat(jid) {
  await delDoc(CHATS, chatId(jid));
}

export async function listChats() {
  const all = await listDocs(CHATS);
  return all.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

/* ------------------------------- session ------------------------------ */

const SESSION = "waSession";

export async function readSessionKey(id) {
  const doc = await getDoc(SESSION, id);
  return doc?.value ?? null;
}

export async function writeSessionKey(id, value) {
  await setDoc(SESSION, id, { value });
}

export async function removeSessionKey(id) {
  await delDoc(SESSION, id);
}

export async function listSessionKeys() {
  return (await listDocs(SESSION)).map((d) => d.id);
}

export async function clearSession() {
  const ids = await listSessionKeys();
  await Promise.all(ids.map((id) => delDoc(SESSION, id)));
}
