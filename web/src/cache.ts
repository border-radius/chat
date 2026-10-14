// Each room's latest messages, kept in IndexedDB (§7.5): a room opens at once with what it showed last time, while its
// first page loads. One user's at a time: cleared when the session ends (a shared computer must not show the next person
// someone else's rooms), and a room kept for another user is never shown. A convenience, never an error: without
// IndexedDB (a private window, a browser that refuses it) nothing is kept.

import type { Message } from "./lib/types.ts";

export interface Kept {
  items: Message[];
  hasOlder: boolean;
}

export interface Cache {
  /** The room as `user` ("" for a guest) last saw it, if kept. */
  get(user: string, roomId: string): Promise<Kept | undefined>;
  put(user: string, roomId: string, kept: Kept): void;
  /** Forget every room. */
  clear(): void;
}

const STORE = "rooms";

/** A request's result, once it succeeds. */
const done = <T>(req: IDBRequest<T> | IDBOpenDBRequest) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });

export function createCache(name = "chat"): Cache {
  let db: Promise<IDBDatabase> | undefined;
  /** Opened on first use. Requests run in the order they were made (one connection): a clear is never overtaken. */
  const open = () => {
    if (!db) {
      db = new Promise((resolve) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        resolve(done<IDBDatabase>(req));
      });
    }
    return db;
  };
  const run = <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest) =>
    open()
      .then((d) => done<T>(op(d.transaction(STORE, mode).objectStore(STORE))))
      .catch(() => undefined);
  return {
    async get(user, roomId) {
      const kept = await run<(Kept & { user: string }) | undefined>("readonly", (s) => s.get(roomId));
      return kept?.user === user ? { items: kept.items, hasOlder: kept.hasOlder } : undefined;
    },
    put(user, roomId, { items, hasOlder }) {
      void run("readwrite", (s) => s.put({ user, items, hasOlder }, roomId));
    },
    clear() {
      void run("readwrite", (s) => s.clear());
    },
  };
}
