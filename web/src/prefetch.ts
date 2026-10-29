// Keeps the room cache (cache.ts) up to date for rooms with unread messages (§7.5): when a room's unread count goes up,
// its latest page is fetched in the background, so opening it shows the new messages at once. Messages that come within
// DELAY_MS of the first are one fetch, and rooms are fetched one at a time, GAP_MS apart. A room fetched less than
// REFETCH_MS ago waits until then: a busy room that stays unread is fetched every REFETCH_MS, not every DELAY_MS, by
// every user who has it unread (QA BUG-108); its first unread message is still fetched at once. A message deleted in a room
// refetches it too, so the cache never shows its text again. Runs while someone is logged in (unread counts are theirs);
// stopped before the cache is cleared, so nothing lands in it afterwards. Once the room list is in, the rooms that
// aren't kept yet are fetched too (after the unread ones, up to WARM of them): a room not yet opened here opens at once.

import type { Api } from "./api.ts";
import type { Cache } from "./cache.ts";
import { latest, PAGE_SIZE } from "./lib/cursor.ts";
import { createScope, type Scope } from "./scope.ts";
import { type AppState, roomSections, type Store } from "./store.ts";

export interface Prefetch {
  start(): void;
  stop(): void;
}

const DELAY_MS = 1000;
/** Between two fetches: hundreds of rooms must not use up the server's per-IP request limit (QA BUG-94). */
const GAP_MS = 250;
/** Rooms not kept yet that are fetched once the room list is in: the first ones it lists (DMs, then rooms). */
const WARM = 30;
/** Between two fetches of a room, unless it had no unread messages (or one was deleted) since (QA BUG-108). */
const REFETCH_MS = 30_000;

export function createPrefetch({
  api,
  store,
  cache,
  delayMs = DELAY_MS,
  gapMs = GAP_MS,
  refetchMs = REFETCH_MS,
}: {
  api: Api;
  store: Store<AppState>;
  cache: Cache;
  delayMs?: number;
  gapMs?: number;
  refetchMs?: number;
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
      /** Rooms to fetch after those, unless they are kept already. */
      const cold = new Set<string>();
      /** Set from when rooms are due until a run has fetched them: a busy room never puts it off (QA BUG-92). */
      let timer: ReturnType<typeof setTimeout> | undefined;
      /** When each room's last fetch began. */
      const fetched = new Map<string, number>();
      /** Rooms fetched too recently to be due yet: due once REFETCH_MS has passed, if still unread. */
      const later = new Set<string>();
      const ready = (id: string) => (fetched.get(id) ?? 0) <= Date.now() - refetchMs;

      async function drain() {
        for (const id of later) if (ready(id) && later.delete(id) && store.get().unread.get(id)) due.add(id);
        // Rooms due again meanwhile wait for the next run (and REFETCH_MS).
        for (const id of new Set([...due, ...cold])) {
          if (due.delete(id)) cold.delete(id);
          else {
            // A room not kept yet gives way to one that became due meanwhile: the next run fetches that first.
            if (due.size) break;
            cold.delete(id);
            if (id === store.get().activeRoomId || (await cache.get(user, id))) continue;
            if (!s.active) return;
          }
          const unread = store.get().unread.get(id);
          // From when it is asked for: a message that comes while it is on its way waits too.
          fetched.set(id, Date.now());
          const page = await api.page(latest(id), s.signal).catch(() => null);
          if (!s.active) return;
          // Refused (the rate limit, offline): the rest waits for their counts to go up again (or the next start).
          if (!page) {
            due.clear();
            cold.clear();
            break;
          }
          // The open room keeps its own page (and gets every message live).
          if (store.get().user?.id === user && store.get().activeRoomId !== id) {
            cache.put(user, id, { items: page, hasOlder: page.length >= PAGE_SIZE, room: store.get().rooms.get(id), unread });
          }
          await new Promise((r) => setTimeout(r, gapMs));
        }
        timer = undefined;
        if (due.size || cold.size || later.size) schedule();
      }
      const schedule = () => {
        timer ??= setTimeout(drain, delayMs);
      };
      /** `now`: the room had no unread messages before, or one was deleted: fetched even if it just was. */
      const add = (id: string, now = false) => {
        if (id === store.get().activeRoomId) return;
        if (now) fetched.delete(id);
        (ready(id) ? due : later).add(id);
        schedule();
      };

      let warmed = false;
      const warm = (st: AppState) => {
        if (warmed || st.roomsStatus !== "ready") return;
        warmed = true;
        const { dms, rooms } = roomSections(st);
        for (const r of [...dms, ...rooms].slice(0, WARM)) cold.add(r.id);
        schedule();
      };
      s.defer(
        store.subscribe((st, prev) => {
          if (st.unread !== prev.unread) for (const [id, n] of st.unread) if (n > (prev.unread.get(id) ?? 0)) add(id, !prev.unread.get(id));
          warm(st);
        }),
      );
      warm(store.get());
      s.sub(api.subscribeAllMessages((_, m) => m.deleted && add(m.room, true)));
      s.defer(() => clearTimeout(timer));
    },
    stop() {
      scope?.dispose();
      scope = null;
    },
  };
}
