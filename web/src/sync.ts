// Keeps the room list and the user's hidden rows in the store (§7.4): one load, one set of realtime
// subscriptions and a reload after every reconnect, for as long as someone is logged in. Views only read.

import type { Api, Unsubscribe } from "./api.ts";
import { markHidden, removeRoom, unmarkHidden, upsertRoom, type AppState, type Store } from "./store.ts";

export interface Sync {
  /** Load and subscribe. Call once a user is logged in. */
  start(): void;
  /** Unsubscribe and ignore anything still in flight. Leaves the store as it is. */
  stop(): void;
  /** Refetch both lists (also runs on every realtime reconnect, since events may have been missed). */
  reload(): Promise<void>;
}

export function createSync({ api, store }: { api: Api; store: Store<AppState> }): Sync {
  /** Bumped by start/stop: callbacks from an earlier run see a different value and do nothing. */
  let run = 0;
  let running = false;
  let subs: Promise<Unsubscribe>[] = [];
  let offConnect = () => {};

  async function reload() {
    if (!running) return;
    const r = run;
    if (store.get().roomsStatus !== "ready") store.set({ roomsStatus: "loading" });
    try {
      const [rooms, hidden] = await Promise.all([api.listRooms(), api.listHidden()]);
      if (r !== run) return;
      store.set({
        rooms: new Map(rooms.map((x) => [x.id, x])),
        hidden: new Map(hidden.map((x) => [x.room, x.id])),
        roomsStatus: "ready",
      });
    } catch {
      if (r === run) store.set({ roomsStatus: "error" });
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      const r = ++run;
      const live = () => r === run;
      subs = [
        api.subscribeRooms((action, room) => {
          if (live()) store.set(action === "delete" ? removeRoom(room.id) : upsertRoom(room));
        }),
        api.subscribeHidden((action, row) => {
          if (live()) store.set(action === "delete" ? unmarkHidden(row.id) : markHidden(row.room, row.id));
        }),
      ];
      offConnect = api.onConnect((reconnect) => {
        if (reconnect && live()) void reload();
      });
      void reload();
    },
    stop() {
      if (!running) return;
      running = false;
      run++;
      offConnect();
      for (const p of subs) void p.then((off) => off()).catch(() => {});
      subs = [];
    },
    reload,
  };
}
