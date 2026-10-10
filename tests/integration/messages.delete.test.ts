import { describe, expect, it } from "vitest";
import { expectRejected, newRoom, newUser, post, rawDb, status } from "./helpers.ts";

describe("messages soft delete (§5.3, §5.6, §7.6.2)", () => {
  describe("the delete itself", () => {
    it("wipes text, sets deleted and deleted_at", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "regret");
      const res = await a.pb.collection("messages").update(m.id, { deleted: true });
      expect(res).toMatchObject({ deleted: true, text: "", author: a.user.id, room: room.id });
      expect(res.deleted_at).not.toBe("");
      expect(Date.now() - Date.parse(res.deleted_at)).toBeLessThan(60_000);
    });

    it("ignores text sent along with the delete", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "regret");
      const res = await a.pb.collection("messages").update(m.id, { deleted: true, text: "sneaky" });
      expect(res.text).toBe("");
    });

    it("removes the text from the database itself", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "really gone");
      await a.pb.collection("messages").update(m.id, { deleted: true });
      const db = rawDb();
      try {
        const row = db.prepare("SELECT text, deleted FROM messages WHERE id = ?").get(m.id);
        expect(row).toEqual({ text: "", deleted: 1 });
      } finally {
        db.close();
      }
    });

    it("does not set edited_at, and keeps an earlier edited_at", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const plain = await post(a, room.id, "plain");
      expect((await a.pb.collection("messages").update(plain.id, { deleted: true })).edited_at).toBe("");

      const m = await post(a, room.id, "v1");
      const edited = await a.pb.collection("messages").update(m.id, { text: "v2" });
      const deleted = await a.pb.collection("messages").update(m.id, { deleted: true });
      expect(deleted.edited_at).toBe(edited.edited_at);
    });
  });

  describe("after deleting", () => {
    it("the message is still listed, so history stays continuous", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      await post(a, room.id, "one");
      const m = await post(a, room.id, "two");
      await post(a, room.id, "three");
      await a.pb.collection("messages").update(m.id, { deleted: true });
      const list = await a.pb.collection("messages").getFullList({ filter: `room = "${room.id}"`, sort: "created,id" });
      expect(list.map((x) => [x.text, x.deleted])).toEqual([
        ["one", false],
        ["", true],
        ["three", false],
      ]);
    });

    it("a deleted message cannot be edited or undeleted", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "bye");
      await a.pb.collection("messages").update(m.id, { deleted: true });
      await expectRejected(a.pb.collection("messages").update(m.id, { text: "resurrect" }));
      await expectRejected(a.pb.collection("messages").update(m.id, { deleted: false }));
      expect(await a.pb.collection("messages").getOne(m.id)).toMatchObject({ deleted: true, text: "" });
    });
  });

  describe("permissions", () => {
    it("another user cannot delete", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "mine");
      await expectRejected(b.pb.collection("messages").update(m.id, { deleted: true }));
      expect((await a.pb.collection("messages").getOne(m.id)).deleted).toBe(false);
    });

    it("deleted_at cannot be set directly", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "x");
      await expectRejected(a.pb.collection("messages").update(m.id, { deleted_at: "2020-01-01 00:00:00.000Z" }));
    });

    it("the DELETE endpoint is refused, even for the author", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "x");
      expect(await status(a.pb.collection("messages").delete(m.id))).toBe(403);
      expect((await a.pb.collection("messages").getOne(m.id)).text).toBe("x");
    });

    it("deleting in an archived room is rejected", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "x");
      await a.pb.collection("rooms").update(room.id, { archived: true });
      await expectRejected(a.pb.collection("messages").update(m.id, { deleted: true }));
    });
  });
});
