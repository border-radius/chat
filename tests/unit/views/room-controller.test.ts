import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "../../../web/src/api.ts";
import { newId } from "../../../web/src/lib/id.ts";
import type { Message, Room } from "../../../web/src/lib/types.ts";
import { createScope, type Scope } from "../../../web/src/scope.ts";
import { type AppState, createStore, initialState, type Store, upsertRoom } from "../../../web/src/store.ts";
import { type Change, createRoomController, type RoomController } from "../../../web/src/views/room/controller.ts";
import { instrument, intercept, type SignedUp, seedMessages, signedUp, subscribed, uniq } from "../../support/api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("room controller (§7.5, no DOM)", () => {
  let me: SignedUp;
  let store: Store<AppState>;
  let scope: Scope;
  let ctl: RoomController;
  let changes: Change[];
  /** What the view would answer to "is the list at the bottom?". */
  let nearBottom: boolean;

  beforeEach(async () => {
    me = await signedUp("Me");
    store = createStore<AppState>({ ...initialState(), user: me.user });
    nearBottom = true;
  });
  afterEach(async () => {
    scope?.dispose();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  // ---- helpers ----

  const newRoom = (owner: SignedUp = me): Promise<Room> => owner.api.createRoom(`room-${uniq()}`);
  const state = () => ctl.state();
  const ids = () => state().win.items.map((m) => m.id);
  const ready = () => vi.waitFor(() => expect(state().phase).toBe("ready"));
  const say = (who: SignedUp, room: Room, text = "hi") => who.api.send({ id: newId(), room: room.id, text });

  /** Start a controller (without waiting for the first load). */
  function start(room: Room | string, msgId?: string, api: Api = me.api) {
    scope = createScope();
    changes = [];
    ctl = createRoomController({
      api,
      store,
      roomId: typeof room === "string" ? room : room.id,
      msgId,
      scope,
      nearBottom: () => nearBottom,
      onChange: (c) => changes.push(c),
    });
    ctl.start();
  }

  /** Start, wait for the first page and for the realtime subscription. */
  async function open(room: Room, msgId?: string) {
    start(room, msgId);
    await ready();
    await subscribed(me.api);
  }

  /** The window must be a contiguous slice of `all`. */
  function contiguous(all: Message[]) {
    const shown = ids();
    const from = all.findIndex((m) => m.id === shown[0]);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(shown).toEqual(all.slice(from, from + shown.length).map((m) => m.id));
  }

  /** Drop realtime message events while `offline` (a dropped connection); `dropped` counts them. */
  function gateRealtime(api: Api) {
    const gate = { offline: false, dropped: 0 };
    intercept(
      api,
      "subscribeMessages",
      (original) => (roomId, fn) =>
        original(roomId, (action, rec) => {
          if (gate.offline) gate.dropped++;
          else fn(action, rec);
        }),
    );
    return gate;
  }

  // ---- first load ----

  describe("first load", () => {
    it("loads the latest page and asks to scroll to the bottom", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 120);
      start(room);
      expect(state().phase).toBe("loading");
      await ready();
      expect(ids()).toEqual(all.slice(70).map((m) => m.id));
      expect(state().win).toMatchObject({ hasOlder: true, hasNewer: false });
      expect(changes.at(-1)).toEqual({ render: {}, notice: "", scroll: "bottom" });
      expect(store.get().rooms.get(room.id)?.id).toBe(room.id);
    });

    it("a message id opens the window around it and asks to centre it", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      start(room, all[150]!.id);
      await ready();
      expect(state().targetId).toBe(all[150]!.id);
      expect(state().win).toMatchObject({ hasOlder: true, hasNewer: true });
      contiguous(all);
      expect(changes.at(-1)?.scroll).toBe("target");
    });

    it("a message from another room falls back to the latest page, with a notice", async () => {
      const room = await newRoom();
      const elsewhere = await say(me, await newRoom(), "elsewhere");
      const here = await say(me, room, "here");
      start(room, elsewhere.id);
      await ready();
      expect(ids()).toEqual([here.id]);
      expect(state().targetId).toBeNull();
      expect(changes.at(-1)).toMatchObject({
        scroll: "bottom",
        notice: "That message isn't in this room. Showing the latest messages instead.",
      });
    });

    it("an unknown room is not-found", async () => {
      start("doesnotexist123");
      await vi.waitFor(() => expect(state().phase).toBe("not-found"));
    });

    it("a failed load is 'failed' (never an empty window); retry() and a reconnect load again", async () => {
      const room = await newRoom();
      const m = await say(me, room, "here all along");
      const net = instrument(me.api);
      net.failNext("getRoom", new ApiError("Failed to fetch", 0));
      start(room);
      await vi.waitFor(() => expect(state().phase).toBe("failed"));
      net.failNext("page", new ApiError("Failed to fetch", 0));
      ctl.retry();
      expect(state().phase).toBe("loading");
      await vi.waitFor(() => expect(state().phase).toBe("failed")); // the page fails this time
      net.reconnect();
      await ready();
      expect(ids()).toEqual([m.id]);
    });

    it("live messages that arrive before the first page are replayed once it is in, without duplicates", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const seen: string[] = [];
      intercept(
        me.api,
        "subscribeMessages",
        (original) => (roomId, fn) =>
          original(roomId, (action, rec) => {
            seen.push(rec.id);
            fn(action, rec);
          }),
      );
      const net = instrument(me.api);
      const release = net.hold("page");
      start(room);
      await subscribed(me.api);
      const early = await say(other, room, "early bird");
      await vi.waitFor(() => expect(seen).toContain(early.id));
      expect(state().phase).toBe("loading");
      release();
      await ready();
      expect(ids().filter((id) => id === early.id)).toHaveLength(1);
    });

    it("after the scope ends, nothing changes and nothing is reported", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await open(room);
      scope.dispose();
      const n = changes.length;
      await say(other, room, "late");
      await sleep(100);
      expect(changes).toHaveLength(n);
      expect(ids()).toEqual([]);
    });
  });

  // ---- the window ----

  describe("the window (§7.5)", () => {
    it("walks back to the very first message, never holding more than 300", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 1000);
      await open(room);
      let max = 0;
      for (let i = 0; i < 30 && state().win.hasOlder; i++) {
        await ctl.loadEdge("top");
        max = Math.max(max, ids().length);
        contiguous(all);
      }
      expect(state().win).toMatchObject({ hasOlder: false, hasNewer: true });
      expect(ids()[0]).toBe(all[0]!.id);
      expect(max).toBeLessThanOrEqual(300);
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
    });

    it("walks forward again to the live edge", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 450);
      await open(room, all[10]!.id);
      for (let i = 0; i < 20 && state().win.hasNewer; i++) {
        await ctl.loadEdge("bottom");
        expect(ids().length).toBeLessThanOrEqual(300);
        contiguous(all);
      }
      expect(state().win.hasNewer).toBe(false);
      expect(ids().at(-1)).toBe(all.at(-1)!.id);
    });

    it("runs one request per end at a time", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 200);
      const net = instrument(me.api);
      await open(room);
      const release = net.hold("page");
      // Counted from here: under load a reconnect may already have refetched a page.
      const before = net.calls("page");
      const a = ctl.loadEdge("top");
      const b = ctl.loadEdge("top");
      expect(net.calls("page")).toBe(before + 1); // one older page for both
      release();
      await Promise.all([a, b]);
      expect(ids()).toHaveLength(100);
    });

    it("jumps to the first or latest page", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      await open(room);
      await ctl.jump("first");
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(state().win).toMatchObject({ hasOlder: false, hasNewer: true });
      expect(changes.at(-1)).toEqual({ render: {}, notice: "", scroll: "top" });
      await ctl.jump("latest");
      expect(ids()).toEqual(all.slice(250).map((m) => m.id));
      expect(changes.at(-1)?.scroll).toBe("bottom");
    });

    it("discards a page that arrives after a jump", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      await open(room);
      // Each page response waits for its gate, released in an order the test chooses.
      const gates: (() => void)[] = [];
      intercept(me.api, "page", (original) => async (q, signal) => {
        const gate = new Promise<void>((r) => gates.push(r));
        const res = await original(q, signal);
        await gate;
        return res;
      });
      const stale = ctl.loadEdge("top");
      const jump = ctl.jump("first");
      gates[1]!(); // the jump's page arrives first…
      await jump;
      gates[0]!(); // …then the older page
      await stale;
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(state().win.hasOlder).toBe(false);
    });

    it("a jump during the first load wins over the late first page, and the room still becomes ready", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((r) => (releaseFirst = r));
      let n = 0;
      intercept(me.api, "page", (original) => async (q, signal) => {
        const res = await original(q, signal);
        if (n++ === 0) await firstHeld; // only the first load's page is slow
        return res;
      });
      start(room);
      await vi.waitFor(() => expect(n).toBe(1));
      await ctl.jump("first");
      expect(state().phase).toBe("loading");
      releaseFirst();
      await ready();
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(changes.at(-1)?.scroll).toBeUndefined(); // the jump has positioned the list already
    });
  });

  // ---- realtime ----

  describe("realtime and the pill", () => {
    it("at the bottom, a new message is appended and followed", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await open(room);
      const m = await say(other, room);
      await vi.waitFor(() => expect(ids()).toEqual([m.id]));
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
      expect(state().pill).toBeNull();
    });

    it("scrolled up, a new message keeps the view in place and shows 'below' until dismissed", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await open(room);
      nearBottom = false;
      const m = await say(other, room);
      await vi.waitFor(() => expect(ids()).toEqual([m.id]));
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
      expect(state().pill).toBe("below");
      ctl.dismissPill();
      expect(state().pill).toBeNull();
    });

    it("scrolled up, my own message (from another tab) is still followed", async () => {
      const room = await newRoom();
      await open(room);
      nearBottom = false;
      const m = await say(me, room);
      await vi.waitFor(() => expect(ids()).toEqual([m.id]));
      expect(changes.at(-1)?.scroll).toBe("bottom");
    });

    it("away from the live edge, a new message is not appended: the pill says 'history' until a jump", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      await open(room, all[20]!.id);
      const m = await say(other, room);
      await vi.waitFor(() => expect(state().pill).toBe("history"));
      expect(ids()).not.toContain(m.id);
      ctl.dismissPill(); // only dismisses "below"
      expect(state().pill).toBe("history");
      await ctl.jump("latest");
      expect(state().pill).toBeNull();
      expect(ids().at(-1)).toBe(m.id);
    });

    it("edits and deletes apply to messages in the window; others are ignored", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const typo = await say(other, room, "tpyo");
      const gone = await say(other, room, "gone");
      await open(room);
      await other.api.edit(typo.id, "typo");
      await other.api.softDelete(gone.id);
      await vi.waitFor(() => expect(ctl.find(gone.id)?.deleted).toBe(true));
      expect(ctl.find(typo.id)?.text).toBe("typo");
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
    });
  });

  // ---- reconnects ----

  describe("reconnects (§7.5)", () => {
    it("at the live edge, fetches everything missed while disconnected, in order", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 20);
      const gate = gateRealtime(me.api);
      const net = instrument(me.api);
      await open(room);
      gate.offline = true;
      const missed: Message[] = [];
      for (let i = 0; i < 80; i++) missed.push(await say(other, room, `missed ${i}`));
      await vi.waitFor(() => expect(gate.dropped).toBe(80));
      gate.offline = false;
      const pages = net.calls("page");
      net.reconnect();
      await vi.waitFor(() => expect(ids().at(-1)).toBe(missed.at(-1)!.id));
      expect(ids().slice(-80)).toEqual(missed.map((m) => m.id));
      expect(net.calls("page") - pages).toBe(2); // 50 + 30
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
    });

    it("scrolled into history, fetches no new pages", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      const net = instrument(me.api);
      await open(room, all[10]!.id);
      const pages = net.calls("page");
      net.reconnect();
      await vi.waitFor(() => expect(net.calls("changes")).toBe(1));
      expect(net.calls("page")).toBe(pages);
    });

    it("BUG-01: applies edits and deletes missed while disconnected, also scrolled into history", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      const [secret, typo] = [all[10]!, all[11]!];
      const gate = gateRealtime(me.api);
      const net = instrument(me.api);
      await open(room, typo.id);
      expect(state().win.hasNewer).toBe(true);
      gate.offline = true;
      await me.api.softDelete(secret.id);
      await me.api.edit(typo.id, "typo");
      await vi.waitFor(() => expect(gate.dropped).toBe(2));
      expect(ctl.find(secret.id)?.deleted).toBe(false); // missed
      gate.offline = false;
      net.reconnect();
      await vi.waitFor(() => expect(ctl.find(secret.id)?.deleted).toBe(true));
      expect(ctl.find(typo.id)?.text).toBe("typo");
      expect(ctl.find(typo.id)?.edited_at).not.toBe("");
    });
  });

  // ---- sending ----

  describe("sending (§7.5)", () => {
    it("shows a pending copy at once, then the server's, never both", async () => {
      const room = await newRoom();
      await open(room);
      expect(ctl.send("hello")).toBe(true);
      const [pending] = state().win.items;
      expect(pending).toMatchObject({ text: "hello", status: "pending", author: me.user.id });
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
      await vi.waitFor(() => expect(state().win.items[0]!.status).toBeUndefined());
      await sleep(50); // the realtime echo of our own create
      expect(ids()).toEqual([pending!.id]);
    });

    it("from history, jumps to the latest page first", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      await open(room, all[10]!.id);
      ctl.send("from the past");
      await vi.waitFor(() => expect(state().win.items.at(-1)?.text).toBe("from the past"));
      expect(state().win.hasNewer).toBe(false);
      expect(ids()).toContain(all.at(-1)!.id);
    });

    it("not in an archived room", async () => {
      const room = await newRoom();
      await me.api.setArchived(room.id, true);
      await open(room);
      expect(ctl.send("hello")).toBe(false);
      expect(ids()).toEqual([]);
    });

    it("a failed send is marked failed; retrySend uses the same id; discard drops it", async () => {
      const room = await newRoom();
      const net = instrument(me.api);
      await open(room);
      net.failNext("send", new ApiError("Failed to fetch", 0));
      net.failNext("send", new ApiError("Failed to fetch", 0));
      ctl.send("try again");
      await vi.waitFor(() => expect(state().win.items[0]?.status).toBe("failed"));
      const id = ids()[0]!;
      await ctl.retrySend(id);
      expect(ctl.find(id)?.status).toBe("failed");
      await ctl.retrySend(id);
      expect(ctl.find(id)).toMatchObject({ text: "try again" });
      expect(ctl.find(id)?.status).toBeUndefined();

      net.failNext("send", new ApiError("Failed to fetch", 0));
      ctl.send("never mind");
      await vi.waitFor(() => expect(state().win.items.at(-1)?.status).toBe("failed"));
      ctl.discard(ids().at(-1)!);
      expect(ids()).toEqual([id]);
    });
  });

  // ---- edit / delete ----

  describe("edit and delete (§7.6)", () => {
    it("edit shows the new text at once and keeps the server's copy", async () => {
      const room = await newRoom();
      const m = await say(me, room, "tpyo");
      await open(room);
      const saving = ctl.edit(m.id, "typo");
      expect(ctl.find(m.id)?.text).toBe("typo");
      expect(await saving).toBe(true);
      expect(ctl.find(m.id)?.edited_at).not.toBe("");
    });

    it("edit returns null when there is nothing to save: unchanged, someone else's, or deleted", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const mine = await say(me, room, "same");
      const theirs = await say(other, room, "theirs");
      await open(room);
      expect(ctl.edit(mine.id, "same")).toBeNull();
      expect(ctl.edit(theirs.id, "mine now")).toBeNull();
      expect(ctl.editable(theirs)).toBe(false);
      expect(await ctl.remove(mine.id)).toBe(true);
      expect(ctl.edit(mine.id, "back")).toBeNull();
      expect(ctl.lastEditable()).toBeUndefined();
    });

    it("a failed edit or delete puts the old message back and resolves false", async () => {
      const room = await newRoom();
      const m = await say(me, room, "original");
      const net = instrument(me.api);
      await open(room);
      net.failNext("edit", new ApiError("Failed to fetch", 0));
      const saving = ctl.edit(m.id, "changed");
      expect(ctl.find(m.id)?.text).toBe("changed");
      expect(await saving).toBe(false);
      expect(ctl.find(m.id)).toMatchObject({ text: "original", edited_at: "" });

      net.failNext("softDelete", new ApiError("Failed to fetch", 0));
      const deleting = ctl.remove(m.id);
      expect(ctl.find(m.id)).toMatchObject({ text: "", deleted: true });
      expect(await deleting).toBe(false);
      expect(ctl.find(m.id)).toMatchObject({ text: "original", deleted: false });
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
    });

    it("lastEditable is my newest message, skipping deleted ones", async () => {
      const room = await newRoom();
      const older = await say(me, room, "older");
      const newest = await say(me, room, "newest");
      await open(room);
      expect(ctl.lastEditable()?.id).toBe(newest.id);
      await ctl.remove(newest.id);
      expect(ctl.lastEditable()?.id).toBe(older.id);
    });
  });
  describe("reactions (§20.3)", () => {
    const shown = (id: string) => ctl.reactions(ctl.find(id)!).map((r) => [r.emoji, r.users.length]);

    it("mine shows at once and stays while it is on its way, over copies of the message that don't have it yet", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await say(me, room);
      // Hold my request before it reaches the server: copies from the server meanwhile don't have my reaction.
      let send!: () => void;
      const gate = new Promise<void>((r) => (send = r));
      intercept(me.api, "react", (original) => async (...args) => {
        await gate;
        return original(...args);
      });
      await open(room);
      const saving = ctl.react(m.id, "👍", true)!;
      expect(shown(m.id)).toEqual([["👍", 1]]);
      await other.api.react(m.id, "🎉", true);
      await vi.waitFor(() => expect(ctl.find(m.id)!.reactions).toEqual([{ emoji: "🎉", users: [other.user.id] }]));
      expect(shown(m.id)).toEqual([
        ["🎉", 1],
        ["👍", 1],
      ]);
      send();
      expect(await saving).toBe(true);
      expect(ctl.find(m.id)!.reactions).toEqual([
        { emoji: "🎉", users: [other.user.id] },
        { emoji: "👍", users: [me.user.id] },
      ]);
      expect(shown(m.id)).toEqual([
        ["🎉", 1],
        ["👍", 1],
      ]);
    });

    it("not on messages that aren't saved, are deleted, or are in an archived room", async () => {
      const room = await newRoom();
      const m = await say(me, room);
      const gone = await say(me, room);
      await me.api.softDelete(gone.id);
      await open(room);
      expect(ctl.react(gone.id, "👍", true)).toBeNull();
      expect(ctl.react("nosuchmessage00", "👍", true)).toBeNull();
      await me.api.setArchived(room.id, true);
      store.set(upsertRoom({ ...store.get().rooms.get(room.id)!, archived: true }));
      expect(ctl.reactable(ctl.find(m.id)!)).toBe(false);
      expect(ctl.react(m.id, "👍", true)).toBeNull();
    });

    it("a change that failed after I changed that reaction again isn't a failure: the later change says how it went", async () => {
      const room = await newRoom();
      const m = await say(me, room);
      let fail!: () => void;
      const failing = new Promise<never>((_, reject) => (fail = () => reject(new ApiError("offline", 0))));
      let calls = 0;
      intercept(
        me.api,
        "react",
        (original) =>
          (...args) =>
            ++calls === 1 ? failing : original(...args),
      );
      await open(room);
      const first = ctl.react(m.id, "👍", true)!;
      await vi.waitFor(() => expect(calls).toBe(1)); // on its way
      const second = ctl.react(m.id, "👍", false)!;
      fail();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(shown(m.id)).toEqual([]);
    });

    it("the answer brings the whole message: an edit I missed (realtime down) isn't hidden behind it", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await say(other, room, "before");
      const gate = gateRealtime(me.api);
      await open(room);
      gate.offline = true;
      await other.api.edit(m.id, "after");
      expect(await ctl.react(m.id, "👍", true)).toBe(true);
      expect(ctl.find(m.id)).toMatchObject({ text: "after", reactions: [{ emoji: "👍", users: [me.user.id] }] });
      expect(ctl.find(m.id)!.expand?.author?.name).toBe("Other");
    });
  });
});
