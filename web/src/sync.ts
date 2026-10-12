// Keeps the room list and the user's hidden rows in the store (§7.4): one load, one set of realtime
// subscriptions and a reload after every reconnect, for as long as the app runs: for a guest too, who only gets the
// Open Air rooms and has nothing hidden (§23.3). Restarted whenever someone logs in or out. Views only read.
// Unread counts have their own service (unread.ts).

import type { Api } from "./api.ts";
import { createScope, type Scope } from "./scope.ts";
import { type AppState, markHidden, removeRoom, type Store, unmarkHidden, upsertRoom } from "./store.ts";

export interface Sync {
  /** Load and subscribe, as whoever is logged in now (or as a guest). */
  start(): void;
  /** Unsubscribe and ignore anything still in flight. Leaves the store as it is. */
  stop(): void;
  /** Refetch both lists (also runs on every realtime reconnect, since events may have been missed). */
  reload(): Promise<void>;
}

export function createSync({ api, store }: { api: Api; store: Store<AppState> }): Sync {
  /** The current run; callbacks hold on to theirs, so a restart can't revive them. */
  let scope: Scope | null = null;

  /** The current run is a guest's (§23.3). */
  let guest = true;

  async function load(s: Scope) {
    if (store.get().roomsStatus !== "ready") store.set({ roomsStatus: "loading" });
    try {
      const [rooms, hidden] = await Promise.all([api.listRooms(s.signal), guest ? [] : api.listHidden(s.signal)]);
      if (!s.active) return;
      store.set({
        rooms: new Map(rooms.map((x) => [x.id, x])),
        hidden: new Map(hidden.map((x) => [x.room, x.id])),
        roomsStatus: "ready",
      });
    } catch {
      if (s.active) store.set({ roomsStatus: "error" });
    }
  }

  return {
    start() {
      if (scope) return;
      const s = createScope();
      scope = s;
      guest = !api.currentUser();
      s.sub(
        api.subscribeRooms((action, room) => {
          if (s.active) store.set(action === "delete" ? removeRoom(room.id) : upsertRoom(room));
        }),
      );
      if (!guest) {
        s.sub(
          api.subscribeHidden((action, row) => {
            if (s.active) store.set(action === "delete" ? unmarkHidden(row.id) : markHidden(row.room, row.id));
          }),
        );
      }
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
    },
    async reload() {
      if (scope) await load(scope);
    },
  };
}
