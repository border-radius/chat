// Room view: what is on screen is marked read (§18.3).

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "../../../../web/src/api.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import { bumpUnread } from "../../../../web/src/store.ts";
import { instrument, intercept, READ_WINDOW_MS, seedMessages, signedUp } from "../../../support/api.ts";
import { captureHandler, layout, me, mount, newRoom, pill, setView, sleep, store, useRoomView, view } from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("read state (§18.3)", () => {
    /** Calls to api.markRead, as [room, at]. */
    function reads(api: Api) {
      const calls: [string, string][] = [];
      intercept(api, "markRead", (original) => (room, at) => {
        calls.push([room, at]);
        return original(room, at);
      });
      return calls;
    }
    function setVisibility(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    }
    afterEach(() => {
      Reflect.deleteProperty(document, "visibilityState");
    });

    it("opening a room marks it read up to its newest message, on the server and in the store", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      await sleep(20);
      // After my signup (older messages never count) and before now (a read is never later than now).
      const all = await seedMessages(room.id, other.user.id, 3, { stepMs: 1, startAt: Date.now() - 5 });
      expect((await me.api.unreadCounts()).rooms[room.id]).toBe(3);
      store.set(bumpUnread(room.id));
      const calls = reads(me.api);
      await mount(room);
      expect(store.get().unread.has(room.id)).toBe(false);
      await vi.waitFor(() => expect(calls).toEqual([[room.id, all[2]!.created]]), { timeout: 3000 });
      await vi.waitFor(async () => expect((await me.api.unreadCounts()).rooms[room.id]).toBeUndefined());
    });

    it("live messages are read as they arrive, batched into one request", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      const calls = reads(me.api);
      const handlers = captureHandler(me.api);
      await mount(room);
      expect(calls).toEqual([]); // nothing to read in an empty room
      const sent = [
        await other.api.send({ id: newId(), room: room.id, text: "one" }),
        await other.api.send({ id: newId(), room: room.id, text: "two" }),
      ];
      for (const m of sent) handlers[0]!("create", m); // both in one tick: one batch, however slow the sends were
      await vi.waitFor(() => expect(calls).toEqual([[room.id, sent[1]!.created]]), { timeout: 3000 });
    });

    it("leaving sends a pending read right away", async () => {
      const room = await newRoom();
      const [m] = await seedMessages(room.id, me.user.id, 1);
      const calls = reads(me.api);
      await mount(room);
      view!.unmount();
      setView(undefined);
      expect(calls).toEqual([[room.id, m!.created]]);
    });

    it("away from the live edge nothing is marked; leaving asks the server for the real count", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const calls = reads(me.api);
      const ctl = instrument(me.api);
      await mount(room, { msgId: all[150]!.id });
      await sleep(READ_WINDOW_MS);
      expect(calls).toEqual([]);
      const before = ctl.calls("unreadCounts");
      view!.unmount();
      setView(undefined);
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(before + 1));
    });

    it("a hidden tab doesn't mark anything until it is shown again", async () => {
      const room = await newRoom();
      const [m] = await seedMessages(room.id, me.user.id, 1);
      const calls = reads(me.api);
      setVisibility("hidden");
      await mount(room);
      await sleep(READ_WINDOW_MS);
      expect(calls).toEqual([]);
      setVisibility("visible");
      await vi.waitFor(() => expect(calls).toEqual([[room.id, m!.created]]), { timeout: 3000 });
    });

    it("QA: scrolled up, a new message stays unread until you scroll down to it", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      const old = await seedMessages(room.id, other.user.id, 30);
      const calls = reads(me.api);
      const handlers = captureHandler(me.api);
      await mount(room);
      await vi.waitFor(() => expect(calls).toEqual([[room.id, old[29]!.created]]), { timeout: 3000 });
      layout.scrollTo(0);
      const m = await other.api.send({ id: newId(), room: room.id, text: "unseen" });
      handlers[0]!("create", m);
      expect(pill().hidden).toBe(false);
      await sleep(READ_WINDOW_MS);
      expect(calls).toHaveLength(1);
      layout.scrollToBottom();
      await vi.waitFor(() => expect(calls.at(-1)).toEqual([room.id, m.created]), { timeout: 3000 });
    });

    it("QA: a failed read is sent again on the next render", async () => {
      const room = await newRoom();
      const [m] = await seedMessages(room.id, me.user.id, 1);
      const ctl = instrument(me.api);
      ctl.failNext("markRead", new ApiError("Failed to fetch", 0));
      const calls = reads(me.api); // outside the failure, so the failed call is recorded too
      await mount(room);
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 3000 });
      ctl.reconnect(); // the gap fill renders
      await vi.waitFor(
        () =>
          expect(calls).toEqual([
            [room.id, m!.created],
            [room.id, m!.created],
          ]),
        { timeout: 3000 },
      );
    });
  });
});
