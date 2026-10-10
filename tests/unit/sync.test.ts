import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../web/src/api.ts";
import type { Room } from "../../web/src/lib/types.ts";
import { createStore, initialState, type AppState, type Store } from "../../web/src/store.ts";
import { createSync, type Sync } from "../../web/src/sync.ts";
import { instrument, newApi, signedUp, uniq, type SignedUp } from "../support/api.ts";

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
    vi.spyOn(me.api, "listRooms").mockImplementation((signal) => (signals.push(signal), original(signal)));
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
});
