import { describe, expect, it } from "vitest";
import { client, expectRejected, newRoom, newUser, status } from "./helpers.ts";

describe("hidden_rooms rules (§5.4, §5.5)", () => {
  describe("hiding", () => {
    it("a user can hide a room for themselves", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const row = await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
      expect(row).toMatchObject({ user: a.user.id, room: room.id });
    });

    it("cannot hide a room for someone else", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      await expectRejected(a.pb.collection("hidden_rooms").create({ user: b.user.id, room: room.id }));
    });

    it("hiding the same room twice is rejected", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
      await expectRejected(a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id }));
    });

    it("hiding is personal: other users are unaffected", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
      expect(await b.pb.collection("hidden_rooms").getFullList({ filter: `room = "${room.id}"` })).toHaveLength(0);
      expect((await b.pb.collection("rooms").getOne(room.id)).id).toBe(room.id);
    });

    it("anonymous users cannot hide rooms", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      await expectRejected(client().collection("hidden_rooms").create({ user: a.user.id, room: room.id }));
    });
  });

  describe("listing", () => {
    it("a user only ever sees their own rows", async () => {
      const a = await newUser();
      const b = await newUser();
      const r1 = await newRoom(a);
      const r2 = await newRoom(a);
      await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: r1.id });
      await b.pb.collection("hidden_rooms").create({ user: b.user.id, room: r2.id });

      const mine = await a.pb.collection("hidden_rooms").getFullList();
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((r) => r.user === a.user.id)).toBe(true);
    });

    it("anonymous users see nothing", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
      expect((await client().collection("hidden_rooms").getList(1, 50)).items).toHaveLength(0);
    });
  });

  describe("unhiding", () => {
    it("a user can delete their own row", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const row = await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
      await a.pb.collection("hidden_rooms").delete(row.id);
      expect(await a.pb.collection("hidden_rooms").getFullList({ filter: `room = "${room.id}"` })).toHaveLength(0);
    });

    it("another user cannot delete it", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      const row = await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
      await expectRejected(b.pb.collection("hidden_rooms").delete(row.id));
      expect((await a.pb.collection("hidden_rooms").getOne(row.id)).id).toBe(row.id);
    });
  });

  it("rows can never be updated", async () => {
    const a = await newUser();
    const r1 = await newRoom(a);
    const r2 = await newRoom(a);
    const row = await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: r1.id });
    expect(await status(a.pb.collection("hidden_rooms").update(row.id, { room: r2.id }))).toBe(403);
  });
});
