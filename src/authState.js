import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import {
  readSessionKey,
  writeSessionKey,
  removeSessionKey,
  clearSession,
} from "./store.js";

const enc = (value) => JSON.stringify(value, BufferJSON.replacer);
const dec = (value) => (value ? JSON.parse(value, BufferJSON.reviver) : null);
const docId = (type, id) => `${type}-${id}`.replace(/[^\w.-]/g, "_");

/**
 * Baileys auth state persisted in Firebase, so login survives restarts and
 * re-deploys (no repeated pairing).
 */
export async function useRemoteAuthState() {
  const stored = dec(await readSessionKey("creds"));
  const creds = stored || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = dec(await readSessionKey(docId(type, id)));
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) data[id] = value;
          }),
        );
        return data;
      },
      set: async (data) => {
        const tasks = [];
        for (const type of Object.keys(data)) {
          for (const id of Object.keys(data[type])) {
            const value = data[type][id];
            const key = docId(type, id);
            tasks.push(value ? writeSessionKey(key, enc(value)) : removeSessionKey(key));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: async () => writeSessionKey("creds", enc(state.creds)),
    hasSession: Boolean(stored),
    clear: clearSession,
  };
}
