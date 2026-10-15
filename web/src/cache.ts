// Each room's latest messages, kept in IndexedDB (§7.5): a room opens at once with what it showed last time, while its
// first page loads. One user's at a time: cleared when the session ends (a shared computer must not show the next person
// someone else's rooms), and a room kept for another user is never shown. What was kept is also held in memory while
// the page is open: switching back to a room shows it in the same task, without waiting for IndexedDB (or showing an
// empty room for a frame). A convenience, never an error: without IndexedDB (a private window, a browser that
// refuses it) nothing outlives the page.

import type { Message, Room } from "./lib/types.ts";
import type { AppState, Store } from "./store.ts";

export interface Kept {
  items: Message[];
  hasOlder: boolean;
  /** The room itself: after a reload, its header shows before the room list is in. */
  room?: Room | undefined;
  /** Prefetched (prefetch.ts): the room's unread count when the page was asked for. */
  unread?: number | undefined;
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
  let opened: IDBDatabase | undefined;
  /** Opened on first use. Requests run in the order they were made (one connection): a clear is never overtaken. */
  const open = () => {
    if (!db) {
      db = new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        resolve(done<IDBDatabase>(req));
      }).then((d) => (opened = d));
    }
    return db;
  };
  /** Kept since the page loaded, by room. (Not what was read: a read answered after a clear would bring it back.) */
  const mem = new Map<string, Kept & { user: string }>();
  const go = <T>(d: IDBDatabase, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest) => {
    const tx = d.transaction(STORE, mode);
    const result = done<T>(op(tx.objectStore(STORE)));
    tx.commit?.();
    return result;
  };
  /**
   * Once the database is open, the request is made at once: one made as the page goes (`pagehide`) was often
   * lost when it waited for a promise, and is committed at once rather than when the page would next run (QA BUG-104).
   */
  const run = <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> => {
    try {
      return (opened ? go<T>(opened, mode, op) : open().then((d) => go<T>(d, mode, op))).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined); // the connection was closed (the browser does that, e.g. when storage is cleared)
    }
  };
  return {
    async get(user, roomId) {
      const kept = mem.get(roomId) ?? (await run<(Kept & { user: string }) | undefined>("readonly", (s) => s.get(roomId)));
      return kept?.user === user ? kept : undefined;
    },
    put(user, roomId, kept) {
      const row = { ...kept, user };
      mem.set(roomId, row);
      void run("readwrite", (s) => s.put(row, roomId));
    },
    clear() {
      mem.clear();
      void run("readwrite", (s) => s.clear());
    },
  };
}

/**
 * Forget the rooms that leave the loaded room list (access lost, §23.4; a room deleted), not only the open one: kept,
 * the next load would show them until the server said no (QA BUG-101). Returns the unsubscribe.
 */
export function forgetGone(cache: Cache, store: Store<AppState>): () => void {
  return store.subscribe((s, prev) => {
    if (s.roomsStatus !== "ready" || prev.roomsStatus !== "ready" || s.user?.id !== prev.user?.id) return;
    for (const id of prev.rooms.keys()) if (!s.rooms.has(id)) cache.put(s.user?.id ?? "", id, { items: [], hasOlder: false });
  });
}
