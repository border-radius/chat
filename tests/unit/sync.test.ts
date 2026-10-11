import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../web/src/api.ts";
import { newId } from "../../web/src/lib/id.ts";
import type { Room } from "../../web/src/lib/types.ts";
import { type AppState, createStore, initialState, type Store } from "../../web/src/store.ts";
import { createSync, type Sync } from "../../web/src/sync.ts";
import { instrument, intercept, newApi, type SignedUp, signedUp, uniq } from "../support/api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sync (room list + hidden rows)", () => {
  let me: SignedUp;
  let store: Store<AppState>;
  let sync: Sync | undefined;

  beforeEach(async () => {
    me = await signedUp("Me");
    store = createStore<AppState>({ ...initialState(), user: me.user });
  });
  afterEach(async () => {
    sync?.stop();
    sync = undefined;
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  const start = () => {
    sync = createSync({ api: me.api, store });
    sync.start();
    return sync;
  };
  const ready = () => vi.waitFor(() => expect(store.get().roomsStatus).toBe("ready"));

  it("loads rooms and hidden rows into the store", async () => {
    const r = await me.api.createRoom(`room-${uniq()}`);
    const row = await me.api.hideRoom(r.id);
    expect(store.get().roomsStatus).toBe("idle");
    start();
    expect(store.get().roomsStatus).toBe("loading");
    await ready();
    expect(store.get().rooms.get(r.id)).toEqual(r);
    expect(store.get().hidden.get(r.id)).toBe(row.id);
  });

  it("applies live room and hidden-row events", async () => {
    start();
    await ready();
    const other = await signedUp("Other");
    const r = await other.api.createRoom(`elsewhere-${uniq()}`);
    await vi.waitFor(() => expect(store.get().rooms.has(r.id)).toBe(true));

    const otherTab = newApi();
    await otherTab.logIn(me.email, me.password);
    const row = await otherTab.hideRoom(r.id);
    await vi.waitFor(() => expect(store.get().hidden.get(r.id)).toBe(row.id));
    await otherTab.unhideRoom(row.id);
    await vi.waitFor(() => expect(store.get().hidden.has(r.id)).toBe(false));
  });

  it("a failed load sets 'error'; reload() recovers", async () => {
    const ctl = instrument(me.api);
    ctl.failNext("listRooms", new ApiError("Failed to fetch", 0));
    start();
    await vi.waitFor(() => expect(store.get().roomsStatus).toBe("error"));
    await sync!.reload();
    expect(store.get().roomsStatus).toBe("ready");
  });

  it("on reconnect both lists are reloaded, without going back to 'loading'", async () => {
    const ctl = instrument(me.api);
    start();
    await ready();
    const statuses: string[] = [];
    store.subscribe((s) => statuses.push(s.roomsStatus));
    ctl.reconnect();
    await vi.waitFor(() => expect(ctl.calls("listRooms")).toBe(2));
    expect(ctl.calls("listHidden")).toBe(2);
    expect(ctl.calls("unreadCounts")).toBe(2);
    expect(statuses).not.toContain("loading");
  });

  it("subscribes once; stop() unsubscribes and later events change nothing", async () => {
    const ctl = instrument(me.api);
    start();
    await ready();
    expect(ctl.calls("subscribeRooms")).toBe(1);
    expect(ctl.calls("subscribeHidden")).toBe(1);
    sync!.stop();
    const other = await signedUp("Other");
    const r = await other.api.createRoom(`after-${uniq()}`);
    await sleep(300);
    expect(store.get().rooms.has(r.id)).toBe(false);
  });

  it("events still in flight after stop() are ignored (unsubscribe is async)", async () => {
    const handlers: ((action: "create", r: Room) => void)[] = [];
    const original = me.api.subscribeRooms.bind(me.api);
    vi.spyOn(me.api, "subscribeRooms").mockImplementation((fn) => {
      handlers.push(fn);
      return original(fn);
    });
    start();
    await ready();
    sync!.stop();
    handlers[0]!("create", { id: "zzzzzzzzzzzzzzz", name: "late", archived: false, created_by: "x" });
    expect(store.get().rooms.has("zzzzzzzzzzzzzzz")).toBe(false);
  });

  it("stop() cancels a load in flight", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const original = me.api.listRooms.bind(me.api);
    vi.spyOn(me.api, "listRooms").mockImplementation((signal) => {
      signals.push(signal);
      return original(signal);
    });
    start();
    sync!.stop();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("a load that finishes after stop() is discarded", async () => {
    const ctl = instrument(me.api);
    const release = ctl.hold("listRooms");
    start();
    sync!.stop();
    release();
    await sleep(100);
    expect(store.get().roomsStatus).toBe("loading");
    expect(store.get().rooms.size).toBe(0);
  });

  describe("unread counts (§18.3)", () => {
    const say = (who: SignedUp, room: string, text = "hi") => who.api.send({ id: newId(), room, text });
    const count = (room: string) => store.get().unread.get(room);

    it("loads the counts with the rooms", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      await say(other, r.id);
      await say(other, r.id);
      start();
      await ready();
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
      await ready();
      await sleep(300); // let the subscriptions settle
      await say(other, r.id);
      await say(me, r.id);
      await say(other, active.id);
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
      await sleep(300);
      expect(count(r.id)).toBe(1);
      expect(count(active.id)).toBeUndefined();
    });

    it("deleting an unread message brings the count down", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const m = await say(other, r.id);
      await say(other, r.id);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      await sleep(300);
      await other.api.softDelete(m.id);
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
    });

    it("reading a room in another tab clears it here", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const m = await say(other, r.id);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
      await sleep(300);
      const otherTab = newApi();
      await otherTab.logIn(me.email, me.password);
      await otherTab.markRead(r.id, m.created);
      await vi.waitFor(() => expect(count(r.id)).toBeUndefined());
    });

    it("a failed count doesn't fail the room list", async () => {
      const ctl = instrument(me.api);
      ctl.failNext("unreadCounts", new ApiError("Failed to fetch", 0));
      start();
      await ready();
    });

    it("a +1 that arrives while counts are being fetched is added on top of the answer, without a refetch", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      await say(other, r.id);
      await say(other, r.id);
      const ctl = instrument(me.api);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      await sleep(300);
      const release = ctl.hold("unreadCounts");
      sync!.refreshUnread();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(2));
      await sleep(100); // the held request has been answered by the server
      await say(other, r.id); // so it isn't in that answer
      await vi.waitFor(() => expect(count(r.id)).toBe(3));
      release();
      await sleep(400);
      expect(count(r.id)).toBe(3);
      expect(ctl.calls("unreadCounts")).toBe(2);
    });

    it("QA: counts still load in a room that never stops (a message during every count request)", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`busy-${uniq()}`);
      for (let i = 0; i < 3; i++) await say(other, r.id, `backlog ${i}`);
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
  });
});
