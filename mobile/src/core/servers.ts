// The servers this app has connected to. Anyone can host one and there is no directory of them: you type a server's
// address once, the app checks it is a chat server, and keeps it in your list with its title and logo. Each server
// keeps its own session (secure storage), drafts and cached rooms; one is current at a time.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { AuthStore } from "../shared";
import { authKey, isInsecure } from "./urls";

export { displayUrl, isInsecure, normalizeUrl } from "./urls";

export interface Server {
  /** Normalized base URL, e.g. "https://chat.example.com" (the identity of a server in this app). */
  url: string;
  /** The site's title (§24) as last seen, for the list. */
  title: string;
  /** The site's logo URL as last seen, or "". */
  logo: string;
  /** When it was last opened (epoch ms): the list puts the most recent first. */
  usedAt: number;
}

const LIST_KEY = "servers.list";
const CURRENT_KEY = "servers.current";

/**
 * Is there a chat server at `url`? Its health check must answer, and so must the site settings (§24), which every chat
 * server has and a plain PocketBase doesn't. Resolves to the site's title and logo; rejects with a sentence saying why not.
 */
export async function probe(url: string, signal?: AbortSignal): Promise<{ title: string; logo: string }> {
  const get = async (path: string) => {
    try {
      return await fetch(url + path, { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(
        isInsecure(url)
          ? "Can't reach that server. Check the address and your connection."
          : "Can't reach that server. Check the address and your connection. (If it doesn't use HTTPS, type http:// before it.)",
      );
    }
  };
  const health = await get("/api/health");
  if (!health.ok) throw new Error("There's no chat server at that address.");
  const site = await get("/api/collections/site/records?perPage=1&skipTotal=1&fields=id,title,logo&sort=created");
  if (!site.ok) throw new Error("That server isn't a chat server (it has no site settings).");
  try {
    const { items } = (await site.json()) as { items?: { id: string; title?: string; logo?: string }[] };
    const row = items?.[0];
    return {
      title: row?.title || "Chat",
      logo: row?.logo ? `${url}/api/files/site/${encodeURIComponent(row.id)}/${encodeURIComponent(row.logo)}` : "",
    };
  } catch {
    throw new Error("That server isn't a chat server.");
  }
}

// ---- the list

export async function listServers(): Promise<Server[]> {
  try {
    const v = JSON.parse((await AsyncStorage.getItem(LIST_KEY)) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return (v as Server[])
      .filter((s) => typeof s?.url === "string")
      .map((s) => ({ url: s.url, title: s.title || "Chat", logo: s.logo || "", usedAt: s.usedAt || 0 }))
      .sort((a, b) => b.usedAt - a.usedAt);
  } catch {
    return [];
  }
}

async function saveList(list: Server[]) {
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(list));
}

/** Add `server` or bring it up to date (title, logo, last used), keyed by URL. */
export async function upsertServer(server: Server): Promise<Server[]> {
  const list = (await listServers()).filter((s) => s.url !== server.url);
  const next = [server, ...list].sort((a, b) => b.usedAt - a.usedAt);
  await saveList(next);
  return next;
}

export async function removeServer(url: string): Promise<Server[]> {
  const next = (await listServers()).filter((s) => s.url !== url);
  await saveList(next);
  await clearAuth(url);
  if ((await currentServer()) === url) await AsyncStorage.removeItem(CURRENT_KEY);
  return next;
}

export async function currentServer(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

export async function setCurrentServer(url: string | null): Promise<void> {
  if (url) await AsyncStorage.setItem(CURRENT_KEY, url);
  else await AsyncStorage.removeItem(CURRENT_KEY);
}

// ---- sessions, one per server, in secure storage (the browser's localStorage on the web build)

const secure = {
  get: (k: string) => (Platform.OS === "web" ? AsyncStorage.getItem(k) : SecureStore.getItemAsync(k)),
  set: (k: string, v: string) => (Platform.OS === "web" ? AsyncStorage.setItem(k, v) : SecureStore.setItemAsync(k, v)),
  del: (k: string) => (Platform.OS === "web" ? AsyncStorage.removeItem(k) : SecureStore.deleteItemAsync(k)),
};

/** Put the saved session of `url` into `store`, and keep saving it whenever it changes. Returns a stop function. */
export async function persistAuth(url: string, store: AuthStore): Promise<() => void> {
  const key = authKey(url);
  try {
    const raw = await secure.get(key);
    const data = raw ? (JSON.parse(raw) as { token?: string; record?: Record<string, unknown> | null }) : null;
    if (data?.token && data.record) store.save(data.token, data.record as { id: string });
  } catch {
    // unreadable: start logged out
  }
  // Writes go one after another, so an older session never lands after a newer one.
  let queue: Promise<unknown> = Promise.resolve();
  return store.onChange(() => {
    const value = store.token ? JSON.stringify({ token: store.token, record: store.record }) : null;
    queue = queue.then(() => (value ? secure.set(key, value) : secure.del(key))).catch(() => {});
  });
}

export async function clearAuth(url: string): Promise<void> {
  await secure.del(authKey(url)).catch(() => {});
}
