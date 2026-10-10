// createApi() against a real PocketBase (TODO 3.2): the behavior every view relies on.

import PocketBase, { BaseAuthStore } from "pocketbase";
import { describe, expect, inject, it } from "vitest";
import { ApiError, createApi, type Action, type Api } from "../../web/src/api.ts";
import { PAGE_SIZE, latest, older } from "../../web/src/lib/cursor.ts";
import { newId } from "../../web/src/lib/id.ts";
import type { Message } from "../../web/src/lib/types.ts";

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 7)}`; // unique across parallel workers

async function eventually(fn: () => void, ms = 2_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the call to reject");
}

/** A real client with its own in-memory auth store (no shared localStorage). */
const realClient = (): Api => createApi(new PocketBase(inject("pbUrl"), new BaseAuthStore()));

/** Two fresh logged-in clients and one logged-out client. */
async function setup(): Promise<{ a: Api; b: Api; anon: Api }> {
  const a = realClient();
  const b = realClient();
  await a.signUp({ email: `a-${uniq()}@test.local`, password: "password-123", name: "Alice" });
  await b.signUp({ email: `b-${uniq()}@test.local`, password: "password-123", name: "Bob" });
  return { a, b, anon: realClient() };
}

describe("createApi", () => {
  describe("auth", () => {
    it("signUp logs the user in; logOut clears; logIn restores", async () => {
      const { anon } = await setup();
      const email = `c-${uniq()}@test.local`;
      const user = await anon.signUp({ email, password: "password-123", name: "  Ada  " });
      expect(user).toEqual({ id: expect.any(String), name: "Ada" });
      expect(anon.currentUser()).toEqual(user);
      expect(await anon.refreshAuth()).toEqual(user);

      anon.logOut();
      expect(anon.currentUser()).toBeNull();
      await expect(anon.refreshAuth()).rejects.toBeInstanceOf(ApiError);

      expect(await anon.logIn(email, "password-123")).toEqual(user);
      expect(anon.currentUser()).toEqual(user);
    });

    it("bad credentials reject with 400", async () => {
      const { anon } = await setup();
      const err = await rejection(anon.logIn(`nobody-${uniq()}@test.local`, "wrong-password"));
      expect(err.status).toBe(400);
      expect(anon.currentUser()).toBeNull();
    });

    it("signup validation errors are reported per field", async () => {
      const { anon } = await setup();
      const err = await rejection(anon.signUp({ email: "not-an-email", password: "password-123", name: "x" }));
      expect(err.status).toBe(400);
      expect(Object.keys(err.fields)).toContain("email");
    });
  });

  describe("rooms", () => {
    it("create, list, get", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(` general-${uniq()} `);
      expect(room).toEqual({ id: expect.any(String), name: room.name.trim(), archived: false, created_by: a.currentUser()!.id });
      expect(await b.getRoom(room.id)).toEqual(room);
      expect((await b.listRooms()).find((r) => r.id === room.id)).toEqual(room);
    });

    it("duplicate names (any case) are rejected with a name field error", async () => {
      const { a, b } = await setup();
      const name = `Dup-${uniq()}`;
      await a.createRoom(name);
      const err = await rejection(b.createRoom(name.toLowerCase()));
      expect(err.status).toBe(400);
      expect(Object.keys(err.fields)).toContain("name");
      expect(err.codes.name).toBe("validation_not_unique"); // what the room list matches on
    });

    it("only the creator can archive and unarchive", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`arch-${uniq()}`);
      await rejection(b.setArchived(room.id, true));
      expect((await a.setArchived(room.id, true)).archived).toBe(true);
      expect((await a.setArchived(room.id, false)).archived).toBe(false);
    });
  });

  describe("hidden rooms", () => {
    it("hide, list (own only), unhide", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`hide-${uniq()}`);
      const row = await a.hideRoom(room.id);
      expect(row).toEqual({ id: expect.any(String), room: room.id });
      expect(await a.listHidden()).toContainEqual(row);
      expect(await b.listHidden()).not.toContainEqual(row);
      await rejection(a.hideRoom(room.id));
      await a.unhideRoom(row.id);
      expect(await a.listHidden()).not.toContainEqual(row);
    });
  });

  describe("messages", () => {
    it("send honors the client id, trims, and returns the author name", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`m-${uniq()}`);
      const id = newId();
      const m = await a.send({ id, room: room.id, text: "  hello  " });
      expect(m).toMatchObject({ id, room: room.id, text: "hello", author: a.currentUser()!.id, edited_at: "", deleted: false });
      expect(m.expand?.author).toEqual(a.currentUser());
      expect(m.created).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z$/);
    });

    it("resending the same id is rejected (safe retries)", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`m-${uniq()}`);
      const id = newId();
      await a.send({ id, room: room.id, text: "once" });
      expect((await rejection(a.send({ id, room: room.id, text: "twice" }))).status).toBe(400);
    });

    it("blank text is rejected with a text field error", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`m-${uniq()}`);
      const err = await rejection(a.send({ id: newId(), room: room.id, text: "   " }));
      expect(err.status).toBe(400);
      expect(Object.keys(err.fields)).toContain("text");
    });

    it("pages newest-first with cursors and author names, never emails", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`p-${uniq()}`);
      const sent: Message[] = [];
      for (let i = 0; i < PAGE_SIZE + 5; i++) sent.push(await a.send({ id: newId(), room: room.id, text: `n${i}` }));

      const p1 = await b.page(latest(room.id));
      expect(p1.map((m) => m.text)).toEqual(sent.slice(5).reverse().map((m) => m.text));
      expect(p1[0]!.expand?.author?.name).toBe(a.currentUser()!.name);
      expect(JSON.stringify(p1)).not.toContain("@test.local");

      const p2 = await b.page(older(room.id, p1[p1.length - 1]!));
      expect(p2.map((m) => m.text)).toEqual(["n4", "n3", "n2", "n1", "n0"]);
    });

    it("edit stamps edited_at; others can't edit", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`e-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "v1" });
      await rejection(b.edit(m.id, "hijack"));
      const e = await a.edit(m.id, " v2 ");
      expect(e).toMatchObject({ id: m.id, text: "v2" });
      expect(e.edited_at).not.toBe("");
      expect(e.expand?.author).toEqual(a.currentUser());
    });

    it("softDelete wipes text and freezes the message", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`d-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "bye" });
      await rejection(b.softDelete(m.id));
      const d = await a.softDelete(m.id);
      expect(d).toMatchObject({ id: m.id, text: "", deleted: true });
      await rejection(a.edit(m.id, "back"));
    });

    it("archived rooms are read-only", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`ro-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "before" });
      await a.setArchived(room.id, true);
      await rejection(a.send({ id: newId(), room: room.id, text: "after" }));
      await rejection(a.edit(m.id, "changed"));
      await rejection(a.softDelete(m.id));
      expect((await a.page(latest(room.id))).map((x) => x.text)).toEqual(["before"]);
    });

    it("getMessage returns one message with its author name; unknown ids reject with 404", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`g-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "find me" });
      expect(await b.getMessage(m.id)).toEqual(m);
      expect((await rejection(b.getMessage("doesnotexist123"))).status).toBe(404);
    });

    it("anonymous clients can't read", async () => {
      const { a, anon } = await setup();
      const room = await a.createRoom(`anon-${uniq()}`);
      await a.send({ id: newId(), room: room.id, text: "secret" });
      expect(await anon.page(latest(room.id))).toEqual([]);
    });

    it("every read accepts a signal; aborted reads reject with status 0 (network-like, never 'logged out')", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`ab-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "hi" });
      const ac = new AbortController();
      ac.abort();
      const reads = [
        a.page(latest(room.id), ac.signal),
        a.listRooms(ac.signal),
        a.listHidden(ac.signal),
        a.getRoom(room.id, ac.signal),
        a.getMessage(m.id, ac.signal),
      ];
      for (const read of reads) expect((await rejection(read)).status).toBe(0);
    });
  });

  describe("realtime", () => {
    it("message subscribers get create/update events for their room only, with author names", async () => {
      const { a, b } = await setup();
      const r1 = await a.createRoom(`rt1-${uniq()}`);
      const r2 = await a.createRoom(`rt2-${uniq()}`);
      const events: [Action, Message][] = [];
      const off = await b.subscribeMessages(r1.id, (action, rec) => events.push([action, rec]));
      try {
        const m = await a.send({ id: newId(), room: r1.id, text: "live" });
        await a.send({ id: newId(), room: r2.id, text: "elsewhere" });
        await a.edit(m.id, "edited");
        await a.softDelete(m.id);
        await eventually(() => expect(events).toHaveLength(3));
        expect(events.map(([act, rec]) => [act, rec.text, rec.deleted])).toEqual([
          ["create", "live", false],
          ["update", "edited", false],
          ["update", "", true],
        ]);
        expect(events[0]![1].expand?.author).toEqual(a.currentUser());
      } finally {
        await off();
      }
    });

    it("after unsubscribing, no more events arrive", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`unsub-${uniq()}`);
      const events: unknown[] = [];
      const off = await b.subscribeMessages(room.id, (...e) => events.push(e));
      await off();
      await a.send({ id: newId(), room: room.id, text: "unheard" });
      await new Promise((r) => setTimeout(r, 300));
      expect(events).toHaveLength(0);
    });

    it("room and hidden-room subscriptions", async () => {
      const { a, b } = await setup();
      const rooms: [Action, string, boolean][] = [];
      const hiddenA: [Action, string][] = [];
      const hiddenB: unknown[] = [];
      const offRooms = await b.subscribeRooms((act, r) => rooms.push([act, r.name, r.archived]));
      const offHa = await a.subscribeHidden((act, h) => hiddenA.push([act, h.room]));
      const offHb = await b.subscribeHidden((...e) => hiddenB.push(e));
      try {
        const room = await a.createRoom(`sub-${uniq()}`);
        await a.setArchived(room.id, true);
        const row = await a.hideRoom(room.id);
        await a.unhideRoom(row.id);
        await eventually(() => {
          expect(rooms.filter(([, n]) => n === room.name)).toEqual([
            ["create", room.name, false],
            ["update", room.name, true],
          ]);
          expect(hiddenA).toEqual([
            ["create", room.id],
            ["delete", room.id],
          ]);
        });
        await new Promise((r) => setTimeout(r, 200));
        expect(hiddenB).toHaveLength(0);
      } finally {
        await offRooms();
        await offHa();
        await offHb();
      }
    });

    it("onConnect registered while already connected reports the next connection as a reconnect", async () => {
      const pb = new PocketBase(inject("pbUrl"), new BaseAuthStore());
      const api = createApi(pb);
      await api.signUp({ email: `r-${uniq()}@test.local`, password: "password-123", name: "R" });
      const unsub = await api.subscribeRooms(() => {});
      await eventually(() => expect(pb.realtime.isConnected).toBe(true));
      const calls: boolean[] = [];
      const off = api.onConnect((re) => calls.push(re)); // registered after the connection is up
      try {
        // Force the SDK down its real reconnect path (as after a dropped connection).
        (pb.realtime as unknown as { connectErrorHandler(e: Error): void }).connectErrorHandler(new Error("dropped"));
        await eventually(() => expect(calls).toEqual([true]), 5_000);
      } finally {
        off();
        await unsub();
        await api.unsubscribeAll();
      }
    });

    it("onConnect fires with reconnect=false for the first connection", async () => {
      const { a } = await setup();
      const calls: boolean[] = [];
      const off = a.onConnect((re) => calls.push(re));
      const unsub = await a.subscribeRooms(() => {});
      try {
        await eventually(() => expect(calls).toEqual([false]));
      } finally {
        off();
        await unsub();
      }
    });
  });
});
