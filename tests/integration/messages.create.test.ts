import { describe, expect, it } from "vitest";
import { client, expectRejected, newRoom, newUser, post, status } from "./helpers.ts";

const pbId = () => Array.from({ length: 15 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");

describe("messages create (§5.3, §5.5, §5.6)", () => {
  describe("author", () => {
    it("a user can post as themselves", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "hello");
      expect(m).toMatchObject({ room: room.id, author: a.user.id, text: "hello", deleted: false, edited_at: "", deleted_at: "" });
    });

    it("cannot post as someone else", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      await expectRejected(a.pb.collection("messages").create({ room: room.id, author: b.user.id, text: "spoof" }));
    });

    it("anonymous users cannot post", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      await expectRejected(client().collection("messages").create({ room: room.id, author: a.user.id, text: "anon" }));
    });

    it("anonymous users cannot list or view messages", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "secret");
      expect(
        (
          await client()
            .collection("messages")
            .getList(1, 50, { filter: `room = "${room.id}"` })
        ).items,
      ).toHaveLength(0);
      // Only Open Air rooms' messages are readable without an account (§23.3).
      const all = await client().collection("messages").getFullList({ expand: "room" });
      expect(all.every((x) => x.expand?.room?.visibility === "open")).toBe(true);
      expect(await status(client().collection("messages").getOne(m.id))).toBe(404);
    });

    it("any authenticated user can read messages in any room", async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      const m = await post(a, room.id, "public");
      expect((await b.pb.collection("messages").getOne(m.id)).text).toBe("public");
    });
  });

  describe("text", () => {
    it("is trimmed", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      expect((await post(a, room.id, "  hi there \n")).text).toBe("hi there");
    });

    it("keeps inner newlines", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      expect((await post(a, room.id, "line 1\nline 2")).text).toBe("line 1\nline 2");
    });

    it("rejects empty and whitespace-only text", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      await expectRejected(post(a, room.id, ""));
      await expectRejected(post(a, room.id, "  \n\t "));
    });

    it("accepts 2000 chars and rejects 2001", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      expect((await post(a, room.id, "x".repeat(2000))).text).toHaveLength(2000);
      await expectRejected(post(a, room.id, "x".repeat(2001)));
    });
  });

  describe("client-supplied ids (§7.5)", () => {
    it("accepts a 15-char id", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const id = pbId();
      expect((await post(a, room.id, "with id", { id })).id).toBe(id);
    });

    it("rejects reusing an existing id, so a retry can never duplicate", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const id = pbId();
      await post(a, room.id, "once", { id });
      await expectRejected(post(a, room.id, "twice", { id }));
      expect(await a.pb.collection("messages").getFullList({ filter: `room = "${room.id}"` })).toHaveLength(1);
    });
  });

  it("cannot create a message that is already deleted, edited or stamped", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await expectRejected(post(a, room.id, "x", { deleted: true }));
    await expectRejected(post(a, room.id, "x", { deleted_at: "2020-01-01 00:00:00.000Z" }));
    await expectRejected(post(a, room.id, "x", { edited_at: "2020-01-01 00:00:00.000Z" }));
  });

  describe("archived rooms", () => {
    it("rejects posting to an archived room; unarchiving allows it again", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      await a.pb.collection("rooms").update(room.id, { archived: true });
      await expectRejected(post(a, room.id, "too late"));

      await a.pb.collection("rooms").update(room.id, { archived: false });
      expect((await post(a, room.id, "back")).text).toBe("back");
    });
  });
});
