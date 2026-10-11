import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../web/src/api.ts";
import { newId } from "../../web/src/lib/id.ts";
import { type AppState, createStore, initialState, type Store } from "../../web/src/store.ts";
import { createUnread, type Unread } from "../../web/src/unread.ts";
import {
  instrument,
  intercept,
  newApi,
  READ_WINDOW_MS,
  type SignedUp,
  seedMessages,
  signedUp,
  subscribed,
  TEST_TIMING,
  uniq,
} from "../support/api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("unread counts (§18.3)", () => {
  let me: SignedUp;
  let store: Store<AppState>;
  let unread: Unread | undefined;

  beforeEach(async () => {
    me = await signedUp("Me");
    store = createStore<AppState>({ ...initialState(), user: me.user });
  });
  afterEach(async () => {
    unread?.stop();
    unread = undefined;
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  const start = () => {
    unread = createUnread({ api: me.api, store, timing: TEST_TIMING });
    unread.start();
    return unread;
  };
  const say = (who: SignedUp, room: string, text = "hi") => who.api.send({ id: newId(), room, text });
  const count = (room: string) => store.get().unread.get(room);
  /** A room with `n` messages from someone else, all newer than my signup. */
  async function unreadRoom(n: number) {
    const other = await signedUp("Other");
    const r = await other.api.createRoom(`room-${uniq()}`);
    for (let i = 0; i < n; i++) await say(other, r.id);
    return { other, r };
  }

  describe("counts", () => {
    it("loads the counts", async () => {
      const { r } = await unreadRoom(2);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
    });

    it("leaves the active room out of fetched counts (the room view clears it before the server knows)", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const active = await other.api.createRoom(`active-${uniq()}`);
      await say(other, r.id);
      await say(other, active.id);
      store.set({ activeRoomId: active.id });
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
      expect(count(active.id)).toBeUndefined();
    });

    it("live: others' messages count, yours and the active room's don't", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const active = await other.api.createRoom(`active-${uniq()}`);
      store.set({ activeRoomId: active.id });
      start();
      await subscribed(me.api);
      await say(other, r.id);
      await say(me, r.id);
      await say(other, active.id);
      // A marker after them: events arrive in order, so once it has counted, the two above have been handled.
      await say(other, r.id);
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      expect(count(active.id)).toBeUndefined();
    });

    it("deleting an unread message brings the count down", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const m = await say(other, r.id);
      await say(other, r.id);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      await subscribed(me.api);
      await other.api.softDelete(m.id);
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
    });

    it("reading a room in another tab clears it here", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const m = await say(other, r.id);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
      await subscribed(me.api);
      const otherTab = newApi();
      await otherTab.logIn(me.email, me.password);
      await otherTab.markRead(r.id, m.created);
      await vi.waitFor(() => expect(count(r.id)).toBeUndefined());
    });

    it("a failed load is retried on reconnect", async () => {
      const { r } = await unreadRoom(1);
      const ctl = instrument(me.api);
      ctl.failNext("unreadCounts", new ApiError("Failed to fetch", 0));
      start();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(1));
      expect(count(r.id)).toBeUndefined();
      ctl.reconnect();
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
    });

    it("refresh() debounces: several calls in a row make one request", async () => {
      const ctl = instrument(me.api);
      start();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(1));
      for (let i = 0; i < 5; i++) unread!.refresh();
      await sleep(TEST_TIMING.refreshMs * 4);
      expect(ctl.calls("unreadCounts")).toBe(2);
    });

    it("a +1 that arrives while counts are being fetched is added on top of the answer, without a refetch", async () => {
      const { other, r } = await unreadRoom(2);
      const ctl = instrument(me.api);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      await subscribed(me.api);
      const release = ctl.hold("unreadCounts");
      unread!.refresh();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(2));
      await sleep(100); // the held request has been answered by the server
      await say(other, r.id); // so it isn't in that answer
      await vi.waitFor(() => expect(count(r.id)).toBe(3));
      release();
      await sleep(TEST_TIMING.refreshMs * 4); // a refetch would have gone out by now
      expect(count(r.id)).toBe(3);
      expect(ctl.calls("unreadCounts")).toBe(2);
    });

    it("QA: counts still load in a room that never stops (a message during every count request)", async () => {
      const { other, r } = await unreadRoom(3);
      const real = me.api.unreadCounts.bind(me.api);
      intercept(me.api, "unreadCounts", (original) => async (signal) => {
        const res = await original(signal);
        await say(other, r.id, "tick"); // lands while the answer is on its way
        await sleep(150);
        return res;
      });
      start();
      await vi.waitFor(async () => expect(count(r.id)).toBe((await real()).rooms[r.id]), { timeout: 5000 });
      expect(count(r.id)).toBeGreaterThanOrEqual(4);
    });

    it("stop() ignores a load still in flight", async () => {
      const { r } = await unreadRoom(1);
      const ctl = instrument(me.api);
      const release = ctl.hold("unreadCounts");
      start();
      unread!.stop();
      release();
      await sleep(200);
      expect(count(r.id)).toBeUndefined();
    });
  });

  describe("reading a room (RoomReader)", () => {
    /** Calls to api.markRead, as [room, at]. Their promises go to `sent`, if given, to wait for the answers. */
    function reads(sent: Promise<unknown>[] = []) {
      const calls: [string, string][] = [];
      intercept(me.api, "markRead", (original) => (room, at) => {
        calls.push([room, at]);
        const p = original(room, at);
        sent.push(p.catch(() => {}));
        return p;
      });
      return calls;
    }
    /** A room whose messages (from someone else) are newer than my signup and older than now. */
    async function freshRoom(n: number) {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      await sleep(20);
      const msgs = await seedMessages(r.id, other.user.id, n, { stepMs: 1, startAt: Date.now() - 10 });
      return { r, msgs };
    }

    it("seen() clears the count at once and tells the server after the batching delay, with the newest position", async () => {
      const { r, msgs } = await freshRoom(3);
      const calls = reads();
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(3));
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created);
      expect(count(r.id)).toBeUndefined();
      reader.seen(msgs[2]!.created);
      reader.seen(msgs[1]!.created); // older: ignored
      expect(calls).toEqual([]);
      await vi.waitFor(() => expect(calls).toEqual([[r.id, msgs[2]!.created]]), { timeout: 3000 });
      await vi.waitFor(async () => expect((await me.api.unreadCounts()).rooms[r.id]).toBeUndefined());
    });

    it("close() sends a pending read right away; caught up, the count stays clear", async () => {
      const { r, msgs } = await freshRoom(1);
      const calls = reads();
      start();
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created);
      reader.close(true);
      expect(calls).toEqual([[r.id, msgs[0]!.created]]);
      expect(count(r.id)).toBeUndefined();
      reader.seen("9999"); // closed: nothing happens
      await sleep(READ_WINDOW_MS);
      expect(calls).toHaveLength(1);
    });

    it("close() when not caught up refetches the counts", async () => {
      const { r } = await freshRoom(1);
      const ctl = instrument(me.api);
      start();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(1));
      unread!.open(r.id).close(false);
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(2));
    });

    it("flush() sends every pending read now (logout)", async () => {
      const a = await freshRoom(1);
      const b = await freshRoom(1);
      const calls = reads();
      start();
      unread!.open(a.r.id).seen(a.msgs[0]!.created);
      unread!.open(b.r.id).seen(b.msgs[0]!.created);
      unread!.flush();
      expect(calls).toEqual([
        [a.r.id, a.msgs[0]!.created],
        [b.r.id, b.msgs[0]!.created],
      ]);
      unread!.flush();
      expect(calls).toHaveLength(2);
    });

    it("never sends as another user (another tab switched the shared session)", async () => {
      const { r, msgs } = await freshRoom(1);
      const third = await signedUp("Third");
      const calls = reads();
      start();
      const reader = unread!.open(r.id); // for Me
      await me.api.logIn(third.email, third.password); // another tab: the shared session is now Third's
      reader.seen(msgs[0]!.created);
      unread!.flush();
      reader.seen("9999-12-31 23:59:59.999Z"); // a later position: batched, not flushed
      await sleep(READ_WINDOW_MS); // the batched send, too
      reader.close(true);
      expect(calls).toEqual([]);
    });

    it("a failed read is sent again with the next seen()", async () => {
      const { r, msgs } = await freshRoom(1);
      const ctl = instrument(me.api);
      ctl.failNext("markRead", new ApiError("Failed to fetch", 0));
      const sent: Promise<unknown>[] = [];
      const calls = reads(sent); // outside the failure, so the failed call is recorded too
      start();
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created);
      unread!.flush();
      expect(calls).toHaveLength(1);
      await Promise.all(sent); // the failure has come back
      await Promise.resolve(); // and the reader's own catch has run
      reader.seen(msgs[0]!.created); // the same position: sent again only because it failed
      await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
      await vi.waitFor(async () => expect((await me.api.unreadCounts()).rooms[r.id]).toBeUndefined());
    });

    it("after stop(), readers do nothing (the session is over)", async () => {
      const { r, msgs } = await freshRoom(1);
      const calls = reads();
      start();
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created);
      unread!.stop();
      unread!.flush();
      reader.close(true);
      await sleep(READ_WINDOW_MS);
      expect(calls).toEqual([]);
    });
  });
});
