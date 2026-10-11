// Several messages at once (§21): POST /api/chat/delete soft-deletes the caller's own messages, POST /api/chat/forward
// copies messages the caller can see into a room or DM they can write in. All or nothing.

import type { RecordModel } from "pocketbase";
import { describe, expect, it } from "vitest";
import { MSG_FIELDS } from "../../web/src/api.ts";
import { MAX_SELECTED } from "../../web/src/lib/limits.ts";
import {
  adminClient,
  collect,
  eventually,
  expectRejected,
  newRoom,
  newUser,
  openDm,
  pngFile,
  post,
  status,
  type TestUser,
} from "./helpers.ts";

const del = (u: TestUser, messages: unknown) => u.pb.send<RecordModel[]>("/api/chat/delete", { method: "POST", body: { messages } });

const fwd = (u: TestUser, messages: unknown, room: unknown, query?: Record<string, string>) =>
  u.pb.send<RecordModel[]>("/api/chat/forward", { method: "POST", body: { messages, room }, ...(query ? { query } : {}) });

const get = (u: TestUser, id: string) => u.pb.collection("messages").getOne(id);

const roomMessages = (u: TestUser, room: string) =>
  u.pb.collection("messages").getFullList({ filter: u.pb.filter("room = {:room}", { room }), sort: "created,id" });

describe("delete several messages (§21.2)", () => {
  it("soft-deletes them all, answering with the deleted messages", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const m1 = await post(a, room.id, "one");
    const m2 = await post(a, room.id, "two", { files: [pngFile("p.png")] });
    const keep = await post(a, room.id, "three");
    const res = await del(a, [m2.id, m1.id]);
    expect(res.map((m) => [m.id, m.deleted, m.text, m.files])).toEqual([
      [m1.id, true, "", []],
      [m2.id, true, "", []],
    ]);
    expect(await get(b, m1.id)).toMatchObject({ deleted: true, text: "" });
    expect(await get(b, keep.id)).toMatchObject({ deleted: false, text: "three" });
  });

  it("only your own: one message by someone else refuses the whole request (403)", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const mine = await post(a, room.id, "mine");
    const theirs = await post(b, room.id, "theirs");
    expect(await status(del(a, [mine.id, theirs.id]))).toBe(403);
    expect(await get(a, mine.id)).toMatchObject({ deleted: false, text: "mine" });
    expect(await get(a, theirs.id)).toMatchObject({ deleted: false });
  });

  it("is idempotent: already deleted ones are left as they are", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m1 = await post(a, room.id, "one");
    const m2 = await post(a, room.id, "two");
    await del(a, [m1.id]);
    const res = await del(a, [m1.id, m2.id, m2.id]);
    expect(res.map((m) => [m.id, m.deleted])).toEqual([
      [m1.id, true],
      [m2.id, true],
    ]);
  });

  it("refuses archived rooms, unknown or invisible messages, bad bodies, and anonymous callers", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    await a.pb.collection("rooms").update(room.id, { archived: true });
    expect(await status(del(a, [msg.id]))).toBe(400);
    await a.pb.collection("rooms").update(room.id, { archived: false });

    const dm = await openDm(a, b);
    const secret = await post(a, dm.id, "secret");
    expect(await status(del(c, [secret.id]))).toBe(404);
    expect(await status(del(a, [msg.id, "nosuchmessage00"]))).toBe(404);
    for (const bad of [[], "x", [1], [""], null, Array.from({ length: MAX_SELECTED + 1 }, (_, i) => `m${i}`)]) {
      expect(await status(del(a, bad))).toBe(400);
    }
    expect(await get(a, msg.id)).toMatchObject({ deleted: false });
    a.pb.authStore.clear();
    expect(await status(del(a, [msg.id]))).toBe(401);
  });

  it("everyone in the room sees the deletes live", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const m1 = await post(a, room.id, "one");
    const m2 = await post(a, room.id, "two");
    const sub = await collect(b.pb, "messages", { filter: `room = "${room.id}"` });
    try {
      await del(a, [m1.id, m2.id]);
      await eventually(() =>
        expect(sub.events.filter((e) => e.action === "update" && e.record.deleted).map((e) => e.record.id)).toEqual([m1.id, m2.id]),
      );
    } finally {
      await sub.stop();
    }
  });
});

describe("forward messages (§21.3)", () => {
  it("copies them into the room in their order, by the caller, saying who first wrote them", async () => {
    const a = await newUser();
    const b = await newUser();
    const from = await newRoom(a);
    const to = await newRoom(b);
    const m1 = await post(a, from.id, "first");
    const m2 = await post(b, from.id, "second");
    const reply = await post(a, from.id, "third", { reply_to: m1.id });
    await b.pb.send("/api/chat/reactions", { method: "POST", body: { message: m1.id, emoji: "👍", on: true } });

    const res = await fwd(b, [reply.id, m1.id, m2.id], to.id);
    expect(res.map((m) => [m.room, m.author, m.text, m.forwarded_from, m.reply_to, m.reactions, m.edited_at])).toEqual([
      [to.id, b.user.id, "first", a.user.id, "", [], ""],
      [to.id, b.user.id, "second", b.user.id, "", [], ""],
      [to.id, b.user.id, "third", a.user.id, "", [], ""],
    ]);
    expect((await roomMessages(a, to.id)).map((m) => m.text)).toEqual(["first", "second", "third"]);
    // The originals are untouched.
    expect(await get(a, m1.id)).toMatchObject({ room: from.id, text: "first", forwarded_from: "" });
  });

  it("a forward of a forward still names who first wrote it", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const r1 = await newRoom(a);
    const r2 = await newRoom(b);
    const r3 = await newRoom(c);
    const msg = await post(a, r1.id, "origin");
    const [once] = await fwd(b, [msg.id], r2.id);
    const [twice] = await fwd(c, [once!.id], r3.id);
    expect(twice).toMatchObject({ author: c.user.id, forwarded_from: a.user.id, text: "origin" });
  });

  it("a forward can be deleted but not edited: its words are someone else's", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(b, room.id, "I said this");
    const [copy] = await fwd(a, [msg.id], room.id);
    expect(await status(a.pb.collection("messages").update(copy!.id, { text: "I never said this" }))).toBe(400);
    expect(await get(b, copy!.id)).toMatchObject({ text: "I said this", edited_at: "" });
    expect(await a.pb.collection("messages").update(copy!.id, { text: "I said this" })).toMatchObject({ edited_at: "" });
    expect((await del(a, [copy!.id]))[0]).toMatchObject({ deleted: true, text: "" });
  });

  it("copies the attachments with their names, readable in the new room", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "", { files: [pngFile("holiday.png")] });
    const dm = await openDm(a, b);
    const [copy] = await fwd(a, [msg.id], dm.id);
    expect(copy!.files).toHaveLength(1);
    expect(copy!.files[0]).not.toBe(msg.files[0]);
    expect(Object.values(copy!.file_names)).toEqual(["holiday.png"]);
    const token = await b.pb.files.getToken();
    const res = await fetch(b.pb.files.getURL(copy!, copy!.files[0], { token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("answers expanded like a read of each message", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    const query = { expand: "author,reply_to.author,forwarded_from", fields: MSG_FIELDS };
    const [copy] = await fwd(a, [msg.id], room.id, query);
    expect(copy).toEqual(await a.pb.collection("messages").getOne(copy!.id, query));
    expect(copy!.expand?.forwarded_from).toEqual({ id: a.user.id, name: a.user.name });
    expect(copy).not.toHaveProperty("expand.author.email");
  });

  it("into a DM: only its members; the recipient's closed DM reopens", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "look at this");
    const dm = await openDm(a, b);
    expect(await status(fwd(c, [msg.id], dm.id))).toBe(404);
    const hidden = await b.pb.collection("hidden_rooms").create({ user: b.user.id, room: dm.id });
    await fwd(a, [msg.id], dm.id);
    expect(await status(b.pb.collection("hidden_rooms").getOne(hidden.id))).toBe(404);
    expect((await b.pb.collection("rooms").getOne(dm.id)).last_message_at).not.toBe("");
  });

  it("only messages you can see, not deleted; only rooms you can write in; all or nothing", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(c);
    const visible = await post(c, room.id, "public");
    const dm = await openDm(a, b);
    const secret = await post(a, dm.id, "secret");
    // C can't forward A–B's DM message anywhere, not even with a visible one.
    expect(await status(fwd(c, [visible.id, secret.id], room.id))).toBe(404);
    expect(await status(fwd(c, ["nosuchmessage00"], room.id))).toBe(404);
    expect(await status(fwd(c, [visible.id], "nosuchroom0000"))).toBe(404);
    const gone = await post(c, room.id, "gone");
    await del(c, [gone.id]);
    expect(await status(fwd(c, [visible.id, gone.id], room.id))).toBe(400);
    const archived = await newRoom(c);
    await c.pb.collection("rooms").update(archived.id, { archived: true });
    expect(await status(fwd(c, [visible.id], archived.id))).toBe(400);
    for (const bad of [[], "x", [1], null, Array.from({ length: MAX_SELECTED + 1 }, (_, i) => `m${i}`)]) {
      expect(await status(fwd(c, bad, room.id))).toBe(400);
    }
    expect((await roomMessages(c, room.id)).length).toBe(2); // nothing was forwarded
    c.pb.authStore.clear();
    expect(await status(fwd(c, [visible.id], room.id))).toBe(401);
  });

  it("forwarded_from can't be set or changed by clients, superusers included", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    await expectRejected(post(a, room.id, "fake", { forwarded_from: b.user.id }));
    await expectRejected(post(a, room.id, "fake", { "forwarded_from+": b.user.id }));
    const msg = await post(a, room.id, "real");
    await expectRejected(a.pb.collection("messages").update(msg.id, { forwarded_from: b.user.id }));
    await expectRejected(a.pb.collection("messages").update(msg.id, { "forwarded_from+": b.user.id }));
    const admin = await adminClient();
    await expectRejected(admin.collection("messages").update(msg.id, { forwarded_from: b.user.id }));
    const [copy] = await fwd(a, [msg.id], room.id);
    await expectRejected(a.pb.collection("messages").update(copy!.id, { forwarded_from: "" }));
    expect(await get(a, copy!.id)).toMatchObject({ forwarded_from: a.user.id });
    // Deleting keeps it.
    expect((await del(a, [copy!.id]))[0]).toMatchObject({ deleted: true, forwarded_from: a.user.id });
  });

  it("are rate limited (20 per minute per IP each)", async () => {
    const admin = await adminClient();
    const { rateLimits } = await admin.settings.getAll();
    for (const label of ["POST /api/chat/forward", "POST /api/chat/delete"]) {
      expect(rateLimits.rules).toContainEqual(expect.objectContaining({ label, duration: 60, maxRequests: 20 }));
    }
  });
});
