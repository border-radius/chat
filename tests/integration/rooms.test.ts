import { describe, expect, it } from "vitest";
import { client, expectRejected, newRoom, newUser, status, uniq } from "./helpers.ts";

describe("rooms rules (§5.2, §5.5)", () => {
  describe("create", () => {
    it("any authenticated user can create a room as themselves", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      expect(room.created_by).toBe(a.user.id);
      expect(room.archived).toBe(false);
    });

    it("cannot create a room on behalf of someone else", async () => {
      const a = await newUser();
      const b = await newUser();
      await expectRejected(a.pb.collection("rooms").create({ name: `r-${uniq()}`, created_by: b.user.id }));
    });

    it("cannot create an already-archived room", async () => {
      const a = await newUser();
      await expectRejected(a.pb.collection("rooms").create({ name: `r-${uniq()}`, created_by: a.user.id, archived: true }));
    });

    it("anonymous users cannot create rooms", async () => {
      await expectRejected(
        client()
          .collection("rooms")
          .create({ name: `r-${uniq()}`, created_by: "" }),
      );
    });

    it("trims the name and rejects blank or over-long names", async () => {
      const a = await newUser();
      const n = `trim-${uniq()}`;
      expect((await newRoom(a, `  ${n}  `)).name).toBe(n);
      await expectRejected(newRoom(a, "   "));
      await expectRejected(newRoom(a, "x".repeat(49)));
    });
  });

  describe("unique names", () => {
    it("rejects an exact duplicate", async () => {
      const a = await newUser();
      const name = `dup-${uniq()}`;
      await newRoom(a, name);
      await expectRejected(newRoom(a, name));
    });

    it("rejects a duplicate that differs only in case", async () => {
      const a = await newUser();
      const b = await newUser();
      const name = `Case-${uniq()}`;
      await newRoom(a, name);
      await expectRejected(newRoom(b, name.toUpperCase()));
    });
  });

  describe("list and view", () => {
    it("any authenticated user can list and view rooms", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      expect((await b.pb.collection("rooms").getOne(room.id)).name).toBe(room.name);
      const list = await b.pb.collection("rooms").getFullList({ filter: `id = "${room.id}"` });
      expect(list).toHaveLength(1);
    });

    it("anonymous users cannot list or view rooms", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      expect((await client().collection("rooms").getList(1, 50)).items).toHaveLength(0);
      expect(await status(client().collection("rooms").getOne(room.id))).toBe(404);
    });
  });

  describe("update", () => {
    it("the creator can rename the room", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const name = `renamed-${uniq()}`;
      expect((await a.pb.collection("rooms").update(room.id, { name })).name).toBe(name);
    });

    it("another user cannot rename it", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      await expectRejected(b.pb.collection("rooms").update(room.id, { name: `hijack-${uniq()}` }));
    });

    it("nobody can change created_by", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      await expectRejected(a.pb.collection("rooms").update(room.id, { created_by: b.user.id }));
    });

    it("nobody can set archived_at directly", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      await expectRejected(a.pb.collection("rooms").update(room.id, { archived_at: "2020-01-01 00:00:00.000Z" }));
    });
  });

  describe("delete", () => {
    it("the DELETE endpoint is refused for the creator and for others", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      expect(await status(a.pb.collection("rooms").delete(room.id))).toBe(403);
      expect(await status(b.pb.collection("rooms").delete(room.id))).toBe(403);
      expect((await a.pb.collection("rooms").getOne(room.id)).id).toBe(room.id);
    });
  });
});
