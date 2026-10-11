// Keeps the room list, the user's hidden rows and the unread counts in the store (§7.4, §18.3): one load, one set
// of realtime subscriptions and a reload after every reconnect, for as long as someone is logged in. Views only read.

import type { Api } from "./api.ts";
import { createScope, type Scope } from "./scope.ts";
import { type AppState, bumpUnread, markHidden, removeRoom, type Store, unmarkHidden, upsertRoom } from "./store.ts";

export interface Sync {
  /** Load and subscribe. Call once a user is logged in. */
  start(): void;
  /** Unsubscribe and ignore anything still in flight. Leaves the store as it is. */
  stop(): void;
  /** Refetch both lists (also runs on every realtime reconnect, since events may have been missed). */
  reload(): Promise<void>;
  /** Refetch the unread counts soon (several calls in a row make one request). */
  refreshUnread(): void;
}

/** How long refreshUnread() waits for more calls before it fetches. */
const UNREAD_DEBOUNCE_MS = 250;

export function createSync({ api, store }: { api: Api; store: Store<AppState> }): Sync {
  /** The current run; callbacks hold on to theirs, so a restart can't revive them. */
  let scope: Scope | null = null;
  /**
   * The live +1s received while a count request is in flight. Its answer counts only the messages created up to its
   * `at`, so the later ones are added back on top (never refetched: a busy room would starve the counts, QA).
   */
  let recent: { room: string; created: string }[] = [];
  let inFlight = 0;
  /** `at` of the counts in the store: an older answer that arrives late is dropped. */
  let countedAt = "";
  let unreadTimer: ReturnType<typeof setTimeout> | undefined;

  async function loadUnread(s: Scope) {
    inFlight++;
    try {
      const res = await api.unreadCounts(s.signal).catch(() => null);
      if (!res || !s.active || res.at < countedAt) return;
      countedAt = res.at;
      const unread = new Map(Object.entries(res.rooms));
      for (const b of recent) if (b.created > res.at) unread.set(b.room, (unread.get(b.room) ?? 0) + 1);
      // The active room is the room view's to clear; the server may not have its latest read yet.
      unread.delete(store.get().activeRoomId ?? "");
      store.set({ unread });
    } finally {
      if (--inFlight === 0) recent = [];
    }
  }

  function refreshUnread() {
    const s = scope;
    if (!s) return;
    clearTimeout(unreadTimer);
    unreadTimer = setTimeout(() => void loadUnread(s), UNREAD_DEBOUNCE_MS);
  }

  async function load(s: Scope) {
    if (store.get().roomsStatus !== "ready") store.set({ roomsStatus: "loading" });
    // Counts are extra: failing to get them must not fail the room list.
    void loadUnread(s);
    try {
      const [rooms, hidden] = await Promise.all([api.listRooms(s.signal), api.listHidden(s.signal)]);
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
      countedAt = "";
      s.defer(() => clearTimeout(unreadTimer));
      s.sub(
        api.subscribeRooms((action, room) => {
          if (s.active) store.set(action === "delete" ? removeRoom(room.id) : upsertRoom(room));
        }),
      );
      s.sub(
        api.subscribeHidden((action, row) => {
          if (s.active) store.set(action === "delete" ? unmarkHidden(row.id) : markHidden(row.room, row.id));
        }),
      );
      s.sub(
        api.subscribeAllMessages((action, m) => {
          if (!s.active) return;
          const { user, activeRoomId, unread } = store.get();
          // The room you are in is read as it arrives (the room view marks it); your own messages never count.
          if (action === "create" && m.author !== user?.id && m.room !== activeRoomId) {
            if (inFlight) recent.push({ room: m.room, created: m.created });
            store.set(bumpUnread(m.room));
          } else if (action === "update" && m.deleted && unread.has(m.room)) refreshUnread(); // was it unread?
        }),
      );
      s.sub(
        api.subscribeReads((_action, row) => {
          // Read in another tab or on another device. The room you are in is already at 0 here.
          if (s.active && row.room !== store.get().activeRoomId) refreshUnread();
        }),
      );
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
    refreshUnread,
  };
}
