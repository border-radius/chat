// Media collections (§31): keeps `collections` in the store (yours, and the public ones you follow with how many of
// their items are new) for as long as someone is logged in, refetched whenever one of them or your subscriptions
// change (live), and on every reconnect. Views read the store; what changes a collection (the lazy chunk) calls
// refresh() after.

import type { Api, Unsubscribe } from "./api.ts";
import { createScope, type Scope } from "./scope.ts";
import type { AppState, Store } from "./store.ts";

export interface CollectionsService {
  start(): void;
  stop(): void;
  /** Refetch soon (several calls in a row make one request). */
  refresh(): void;
  /** You have seen the collection up to `at` (its newest item's `created`): its badge goes at once. */
  seen(id: string, at?: string): void;
}

const REFRESH_MS = 250;

export function createCollections({ api, store }: { api: Api; store: Store<AppState> }): CollectionsService {
  let scope: Scope | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The live subscription, for the collections followed when it was made. */
  let live: { key: string; off: Promise<Unsubscribe> } | null = null;
  let issued = 0;

  async function load(s: Scope) {
    const seq = ++issued;
    const res = await api.collections(s.signal).catch(() => null);
    if (!res || !s.active || seq !== issued) return;
    store.set({ collections: res });
    follow(s);
  }

  /** Listen to your collections and those you follow (again, when they changed). */
  function follow(s: Scope) {
    const ids = store.get().collections?.subs.map((c) => c.id) ?? [];
    const key = ids.join();
    if (live?.key === key) return;
    const old = live?.off;
    if (old) void old.then((off) => off()).catch(() => {});
    const off = api.subscribeCollections(ids, refresh);
    live = { key, off };
    s.sub(off);
  }

  function refresh() {
    const s = scope;
    if (!s) return;
    clearTimeout(timer);
    timer = setTimeout(() => void load(s), REFRESH_MS);
  }

  return {
    start() {
      if (scope) return;
      const s = createScope();
      scope = s;
      s.defer(() => clearTimeout(timer));
      s.defer(
        api.onConnect((reconnect) => {
          if (reconnect && s.active) void load(s);
        }),
      );
      void load(s);
    },
    stop() {
      scope?.dispose();
      scope = null;
      live = null;
    },
    refresh,
    seen(id, at) {
      const c = store.get().collections;
      if (c?.subs.some((x) => x.id === id && x.new)) {
        store.set({ collections: { ...c, subs: c.subs.map((x) => (x.id === id ? { ...x, new: 0 } : x)) } });
      }
      void api.markSeen(id, at).catch(() => {});
    },
  };
}
