// Who can post in a room (§23.6): everyone who can read it, or only the writers its creator chose.

import { describe, expect, it } from "vitest";
import { expectRejected, newRoom, newUser, openDm, post, status, type TestUser } from "./helpers.ts";

/** A room of `owner`'s where only `writers` (and the owner) post. */
async function selected(owner: TestUser, writers: TestUser[] = [], extra: Record<string, unknown> = {}) {
  const room = await newRoom(owner);
  return owner.pb.collection("rooms").update(room.id, { posting: "selected", writers: writers.map((w) => w.user.id), ...extra });
}

async function trio() {
  const [a, b, c] = await Promise.all([newUser(), newUser(), newUser()]);
  return { a, b, c };
}

const send = (u: TestUser, path: string, body: Record<string, unknown>) => status(u.pb.send(path, { method: "POST", body }));

describe("posting (§23.6)", () => {
  it("rooms let everyone post until the creator chooses; the creator is always a writer", async () => {
    const { a, b } = await trio();
    const room = await newRoom(a);
    expect(room.posting).toBe("everyone");
    expect(room.writers).toEqual([]);
    const sel = await selected(a, [b, b]);
    expect(sel.posting).toBe("selected");
    expect(sel.writers).toEqual([a.user.id, b.user.id]);
    const again = await a.pb.collection("rooms").update(room.id, { posting: "everyone", writers: [b.user.id] });
    expect(again.writers).toEqual([]);
  });

  it("only writers post; the others still read and react", async () => {
    const { a, b, c } = await trio();
    const room = await selected(a, [b]);
    const m = await post(a, room.id, "announcement");
    expect((await post(b, room.id, "me too")).text).toBe("me too");
    await expectRejected(post(c, room.id, "can I?"));
    expect((await c.pb.collection("messages").getOne(m.id)).text).toBe("announcement");
    expect(await send(c, "/api/chat/reactions", { message: m.id, emoji: "👍", on: true })).toBe(200);
  });

  it("a reader can't forward into the room, but can forward out of it", async () => {
    const { a, b, c } = await trio();
    const room = await selected(a);
    const pub = await newRoom(c);
    const theirs = await post(c, pub.id, "forward me");
    const inside = await post(a, room.id, "worth sharing");
    expect(await send(c, "/api/chat/forward", { messages: [theirs.id], room: room.id })).toBe(400);
    expect(await send(c, "/api/chat/forward", { messages: [inside.id], room: pub.id })).toBe(200);
    expect(await send(b, "/api/chat/forward", { messages: [theirs.id], room: room.id })).toBe(400);
  });

  it("a writer taken off can't edit or delete what they wrote; put back, they can", async () => {
    const { a, b } = await trio();
    const room = await selected(a, [b]);
    const m = await post(b, room.id, "before");
    await a.pb.collection("rooms").update(room.id, { writers: [] });
    await expectRejected(b.pb.collection("messages").update(m.id, { text: "after" }));
    await expectRejected(b.pb.collection("messages").update(m.id, { deleted: true }));
    expect(await send(b, "/api/chat/delete", { messages: [m.id] })).toBe(400);
    expect((await b.pb.collection("messages").getOne(m.id)).text).toBe("before");
    await a.pb.collection("rooms").update(room.id, { "writers+": b.user.id });
    expect((await b.pb.collection("messages").update(m.id, { text: "after" })).text).toBe("after");
  });

  it("in a private room only members can be writers, and a member taken out stops being one", async () => {
    const { a, b, c } = await trio();
    const room = await selected(a, [b, c], { visibility: "private", members: [b.user.id] });
    expect(room.writers).toEqual([a.user.id, b.user.id]);
    const out = await a.pb.collection("rooms").update(room.id, { members: [] });
    expect(out.writers).toEqual([a.user.id]);
  });

  it("writers post in an Open Air room too", async () => {
    const { a, b } = await trio();
    const room = await selected(a, [b], { visibility: "open" });
    expect((await post(b, room.id, "hello web")).text).toBe("hello web");
  });

  it("only the creator chooses; writers can't be set when creating a room", async () => {
    const { a, b } = await trio();
    const room = await newRoom(a);
    await expectRejected(b.pb.collection("rooms").update(room.id, { posting: "selected" }));
    await expectRejected(b.pb.collection("rooms").update(room.id, { writers: [b.user.id] }));
    await expectRejected(a.pb.collection("rooms").create({ name: `w-${Date.now()}`, created_by: a.user.id, writers: [b.user.id] }));
    const sel = await a.pb.collection("rooms").create({ name: `s-${Date.now()}`, created_by: a.user.id, posting: "selected" });
    expect(sel.writers).toEqual([a.user.id]);
    await expectRejected(a.pb.collection("rooms").update(room.id, { posting: "anyone" }));
  });

  it("DMs always let both post", async () => {
    const { a, b } = await trio();
    const dm = await openDm(a, b);
    expect(dm.posting).toBe("everyone");
    await expectRejected(a.pb.collection("rooms").update(dm.id, { posting: "selected" }));
    expect((await post(b, dm.id, "still here")).text).toBe("still here");
  });

  it("rejects unknown users and more than 100 writers", async () => {
    const { a } = await trio();
    const room = await newRoom(a);
    await expectRejected(a.pb.collection("rooms").update(room.id, { posting: "selected", writers: ["nobody000000000"] }));
    const many = Array.from({ length: 100 }, (_, i) => `fake${String(i).padStart(11, "0")}`);
    await expectRejected(a.pb.collection("rooms").update(room.id, { posting: "selected", writers: many }));
  });
});
