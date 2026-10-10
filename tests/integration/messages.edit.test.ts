import { describe, expect, it } from "vitest";
import { expectRejected, newRoom, newUser, post } from "./helpers.ts";

describe("messages edit (§5.3, §5.6, §7.6.1)", () => {
  it("the author can edit; edited_at is stamped", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await post(a, room.id, "frist");
    const edited = await a.pb.collection("messages").update(m.id, { text: "  first  " });
    expect(edited.text).toBe("first");
    expect(edited.edited_at).not.toBe("");
    expect(Date.now() - Date.parse(edited.edited_at)).toBeLessThan(60_000);
  });

  it("an update with unchanged text leaves edited_at empty", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await post(a, room.id, "same");
    const res = await a.pb.collection("messages").update(m.id, { text: "same" });
    expect(res.edited_at).toBe("");
  });

  it("another user cannot edit", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const m = await post(a, room.id, "mine");
    await expectRejected(b.pb.collection("messages").update(m.id, { text: "yours" }));
    expect((await a.pb.collection("messages").getOne(m.id)).text).toBe("mine");
  });

  it("cannot change author or room, or set edited_at directly", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const other = await newRoom(a);
    const m = await post(a, room.id, "stay");
    await expectRejected(a.pb.collection("messages").update(m.id, { author: b.user.id }));
    await expectRejected(a.pb.collection("messages").update(m.id, { room: other.id }));
    await expectRejected(a.pb.collection("messages").update(m.id, { edited_at: "2020-01-01 00:00:00.000Z" }));
    expect(await a.pb.collection("messages").getOne(m.id)).toMatchObject({ author: a.user.id, room: room.id, edited_at: "" });
  });

  it("rejects editing to whitespace-only or over-long text", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await post(a, room.id, "valid");
    await expectRejected(a.pb.collection("messages").update(m.id, { text: "   " }));
    await expectRejected(a.pb.collection("messages").update(m.id, { text: "x".repeat(2001) }));
    expect((await a.pb.collection("messages").getOne(m.id)).text).toBe("valid");
  });

  it("rejects editing in an archived room", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await post(a, room.id, "frozen");
    await a.pb.collection("rooms").update(room.id, { archived: true });
    await expectRejected(a.pb.collection("messages").update(m.id, { text: "thawed" }));
  });
});
