// Service messages (§5.3): the app's own notices, with no author. Only server code makes them (here a superuser stands
// in for it: the same hooks run); nobody can make, change, answer, react to or forward one through the API.
import { describe, expect, it } from "vitest";
import { adminClient, client, newRoom, newUser, post, status } from "./helpers.ts";

const service = async (room: string, text = "Something happened.") => (await adminClient()).collection("messages").create({ room, text });

describe("service messages (§5.3)", () => {
  it("nobody makes one through the API: a message always has its author", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    expect(await status(a.pb.collection("messages").create({ room: room.id, text: "no author" }))).toBe(400);
    expect(await status(a.pb.collection("messages").create({ room: room.id, author: "", text: "no author" }))).toBe(400);
    expect(await status(client().collection("messages").create({ room: room.id, text: "anon" }))).toBe(400);
  });

  it("reads like any message, also in a private room, and counts as unread", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await a.pb.collection("rooms").create({ name: `private-${Date.now()}`, created_by: a.user.id, visibility: "private" });
    const m = await service(room.id, "  Telegram group was connected.  ");
    expect(await a.pb.collection("messages").getOne(m.id)).toMatchObject({ author: "", text: "Telegram group was connected." });
    expect(await status(b.pb.collection("messages").getOne(m.id))).toBe(404);
    const counts = await a.pb.send<{ rooms: Record<string, number> }>("/api/chat/unread", { method: "GET" });
    expect(counts.rooms[room.id]).toBe(1);
  });

  it("can't be edited, deleted, replied to, reacted to or forwarded", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await service(room.id);
    expect(await status(a.pb.collection("messages").update(m.id, { text: "mine now" }))).toBe(404);
    expect(await status(a.pb.collection("messages").update(m.id, { deleted: true }))).toBe(404);
    expect(await status(client().collection("messages").update(m.id, { deleted: true }))).toBe(404);
    expect(await status(a.pb.send("/api/chat/delete", { method: "POST", body: { messages: [m.id] } }))).toBe(403);
    expect(await status(post(a, room.id, "answer", { reply_to: m.id }))).toBe(400);
    expect(await status(a.pb.send("/api/chat/reactions", { method: "POST", body: { message: m.id, emoji: "👍", on: true } }))).toBe(400);
    const other = await newRoom(a);
    expect(await status(a.pb.send("/api/chat/forward", { method: "POST", body: { messages: [m.id], room: other.id } }))).toBe(400);
    expect((await a.pb.collection("messages").getOne(m.id)).text).toBe("Something happened.");
  });

  it("a user who wrote messages can't be deleted: their messages would lose their author and read as the app's", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const b = await newUser();
    const m = await post(b, room.id, "my words");
    const admin = await adminClient();
    expect(await status(admin.collection("users").delete(b.user.id))).toBe(400);
    expect((await admin.collection("messages").getOne(m.id)).author).toBe(b.user.id);
    const quiet = await newUser();
    expect(await status(admin.collection("users").delete(quiet.user.id))).toBe(200);
  });

  it("isn't made in an archived room", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await a.pb.collection("rooms").update(room.id, { archived: true });
    expect(await status(service(room.id))).toBe(400);
  });
});
