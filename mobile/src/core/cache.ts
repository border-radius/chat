// Each room's latest messages, kept between visits and restarts (the web's cache.ts, §7.5, on AsyncStorage): a room
// opens at once with what it showed last time while its first page loads. One server and one user at a time: cleared
// when the session ends, and a room kept for another user is never shown.

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Cache, Kept } from "../shared";

export function createCache(server: string): Cache {
  const prefix = `rooms:${server}|`;
  /** Writes and clears run in order: a clear is never overtaken by a put made before it. */
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  return {
    async get(user, roomId) {
      try {
        await queue;
        const raw = await AsyncStorage.getItem(prefix + roomId);
        const kept = raw ? (JSON.parse(raw) as Kept & { user: string }) : null;
        return kept?.user === user ? { items: kept.items, hasOlder: kept.hasOlder } : undefined;
      } catch {
        return undefined;
      }
    },
    put(user, roomId, { items, hasOlder }) {
      void inTurn(() => AsyncStorage.setItem(prefix + roomId, JSON.stringify({ user, items, hasOlder }))).catch(() => {});
    },
    clear() {
      void inTurn(async () => {
        const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
        if (keys.length) await AsyncStorage.multiRemove(keys);
      }).catch(() => {});
    },
  };
}
