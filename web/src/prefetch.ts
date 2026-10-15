// Keeps the room cache (cache.ts) up to date for rooms with unread messages (§7.5): when a room's unread count goes up,
// its latest page is fetched in the background, so opening it shows the new messages at once. Messages that come within
// DELAY_MS of the first are one fetch, and rooms are fetched one at a time, GAP_MS apart. A message deleted in a room
// refetches it too, so the cache never shows its text again. Runs while someone is logged in (unread counts are theirs);
// stopped before the cache is cleared, so nothing lands in it afterwards.

import type { Api } from "./api.ts";
import type { Cache } from "./cache.ts";
import { latest, PAGE_SIZE } from "./lib/cursor.ts";
import { createScope, type Scope } from "./scope.ts";
import type { AppState, Store } from "./store.ts";

export interface Prefetch {
  start(): void;
  stop(): void;
}

const DELAY_MS = 1000;
/** Between two fetches: hundreds of rooms must not use up the server's per-IP request limit (QA BUG-94). */
const GAP_MS = 250;

export function createPrefetch({
  api,
  store,
  cache,
  delayMs = DELAY_MS,
  gapMs = GAP_MS,
}: {
  api: Api;
  store: Store<AppState>;
  cache: Cache;
  delayMs?: number;
  gapMs?: number;
}): Prefetch {
  let scope: Scope | null = null;

  return {
    start() {
      const user = store.get().user?.id ?? "";
      if (scope || !user) return;
      const s = createScope();
      scope = s;
      /** Rooms to fetch, in the order they became due. */
      const due = new Set<string>();
      /** Set from when rooms are due until a run has fetched them: a busy room never puts it off (QA BUG-92). */
      let timer: ReturnType<typeof setTimeout> | undefined;

      async function drain() {
        // Rooms due again meanwhile wait for the next run: a busy room is fetched about once per DELAY_MS.
        for (const id of [...due]) {
          due.delete(id);
          const unread = store.get().unread.get(id);
          const page = await api.page(latest(id), s.signal).catch(() => null);
          if (!s.active) return;
          // Refused (the rate limit, offline): the rest waits for their counts to go up again.
          if (!page) {
            due.clear();
            break;
          }
          // The open room keeps its own page (and gets every message live).
          if (store.get().user?.id === user && store.get().activeRoomId !== id) {
            cache.put(user, id, { items: page, hasOlder: page.length >= PAGE_SIZE, room: store.get().rooms.get(id), unread });
          }
          await new Promise((r) => setTimeout(r, gapMs));
        }
        timer = undefined;
        if (due.size) schedule();
      }
      const schedule = () => {
        timer ??= setTimeout(drain, delayMs);
      };
      const add = (id: string) => {
        if (id === store.get().activeRoomId) return;
        due.add(id);
        schedule();
      };

      s.defer(
        store.subscribe((st, prev) => {
          if (st.unread !== prev.unread) for (const [id, n] of st.unread) if (n > (prev.unread.get(id) ?? 0)) add(id);
        }),
      );
      s.sub(api.subscribeAllMessages((_, m) => m.deleted && add(m.room)));
      s.defer(() => clearTimeout(timer));
    },
    stop() {
      scope?.dispose();
      scope = null;
    },
  };
}
