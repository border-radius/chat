// Unread counts (§18.3): keeps `unread` in the store and tells the server what has been read, for as long as someone
// is logged in. The room view only reports what it shows (`open(roomId).seen(created)`); this module owns the
// counting, the batching of reads, retries, and whose session a read belongs to.

import type { Api } from "./api.ts";
import { createScope, type Scope } from "./scope.ts";
import { type AppState, bumpUnread, clearUnread, type Store } from "./store.ts";

export interface Unread {
  /** Load the counts and follow them live. Call once a user is logged in. */
  start(): void;
  /** Unsubscribe and ignore anything still in flight. Pending reads are dropped: flush() first to keep them. */
  stop(): void;
  /** Refetch the counts soon (several calls in a row make one request). */
  refresh(): void;
  /** Send every pending read now (before the session ends, e.g. on logout). */
  flush(): void;
  /** Start reading a room (the room view, while mounted). */
  open(roomId: string): RoomReader;
}

export interface RoomReader {
  /** The messages up to `created` (a message's `created`) are on screen: read. Cheap to call on every render. */
  seen(created: string): void;
  /**
   * Leaving the room: send a pending read now. `caughtUp` is whether the newest messages were on screen at the end;
   * if not, messages may have arrived unseen (they aren't counted live in the room you are in), so refetch.
   */
  close(caughtUp: boolean): void;
}

/** How long refresh() waits for more calls before it fetches. */
const REFRESH_DEBOUNCE_MS = 250;
/** How long reads are batched before the server is told. */
const READ_DELAY_MS = 1000;

export function createUnread({ api, store }: { api: Api; store: Store<AppState> }): Unread {
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
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Readers with a read not sent yet. */
  const pending = new Set<{ send(): void }>();

  async function load(s: Scope) {
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

  function refresh() {
    const s = scope;
    if (!s) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void load(s), REFRESH_DEBOUNCE_MS);
  }

  function open(roomId: string): RoomReader {
    /** The session this reader belongs to: reads are never sent from another one. */
    const s = scope;
    /** Whose reads these are: the session is shared with other tabs, which may switch it to someone else. */
    const reader = store.get().user?.id ?? "";
    /** Read up to here: sent, or about to be when `timer` fires. */
    let readAt = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const live = () => !closed && !!s?.active && s === scope;

    const self = {
      send() {
        clearTimeout(timer);
        timer = undefined;
        pending.delete(self);
        if (!s?.active || api.currentUser()?.id !== reader) return; // never as someone else
        const at = readAt;
        api.markRead(roomId, at).catch(() => {
          // Try again with the next seen() (the room view renders after a reconnect's gap fill).
          if (readAt === at && live()) readAt = "";
        });
      },
    };

    return {
      seen(created) {
        if (!live() || created <= readAt) return;
        readAt = created;
        store.set(clearUnread(roomId));
        if (timer) return;
        pending.add(self);
        timer = setTimeout(self.send, READ_DELAY_MS);
      },
      close(caughtUp) {
        if (closed) return;
        if (timer) self.send();
        if (live()) {
          if (caughtUp) store.set(clearUnread(roomId));
          else refresh();
        }
        closed = true;
      },
    };
  }

  return {
    start() {
      if (scope) return;
      const s = createScope();
      scope = s;
      countedAt = "";
      s.defer(() => clearTimeout(refreshTimer));
      s.sub(
        api.subscribeAllMessages((action, m) => {
          if (!s.active) return;
          const { user, activeRoomId, unread } = store.get();
          // The room you are in is read as it arrives (the room view reports it); your own messages never count.
          if (action === "create" && m.author !== user?.id && m.room !== activeRoomId) {
            if (inFlight) recent.push({ room: m.room, created: m.created });
            store.set(bumpUnread(m.room));
          } else if (action === "update" && m.deleted && unread.has(m.room)) refresh(); // was it unread?
        }),
      );
      s.sub(
        api.subscribeReads((_action, row) => {
          // Read in another tab or on another device. The room you are in is already at 0 here.
          if (s.active && row.room !== store.get().activeRoomId) refresh();
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
      pending.clear();
      scope?.dispose();
      scope = null;
    },
    refresh,
    flush() {
      for (const r of [...pending]) r.send();
    },
    open,
  };
}
