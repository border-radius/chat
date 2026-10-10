// Direct messages: who can see and write what (§16.3).

import { describe, expect, it } from "vitest";
import { collect, expectRejected, newRoom, newUser, openDm, post, rawDb, sleep, status } from "./helpers.ts";

/** dm_key straight from the DB (it is hidden from the API). */
function dmKeyOf(roomId: string): string {
  const db = rawDb();
  try {
    return (db.prepare("SELECT dm_key FROM rooms WHERE id = ?").get(roomId) as { dm_key: string }).dm_key;
  } finally {
    db.close();
  }
}

async function trio() {
  const [a, b, c] = await Promise.all([newUser(), newUser(), newUser()]);
  const dm = await openDm(a, b);
  return { a, b, c, dm };
}

describe("DM visibility (§16.3)", () => {
  it("members can list and view the DM; others can't", async () => {
    const { a, b, c, dm } = await trio();
    expect((await a.pb.collection("rooms").getOne(dm.id)).kind).toBe("dm");
    expect((await b.pb.collection("rooms").getOne(dm.id)).id).toBe(dm.id);
    expect(await status(c.pb.collection("rooms").getOne(dm.id))).toBe(404);
    expect(await c.pb.collection("rooms").getFullList({ filter: `id = "${dm.id}"` })).toHaveLength(0);
    // public rooms are still visible to everyone
    const pub = await newRoom(a);
    expect((await c.pb.collection("rooms").getOne(pub.id)).kind).toBe("public");
  });

  it("only members can read or post messages", async () => {
    const { a, b, c, dm } = await trio();
    const m = await post(a, dm.id, "secret");
    expect((await post(b, dm.id, "reply")).text).toBe("reply");
    expect(await status(c.pb.collection("messages").getOne(m.id))).toBe(404);
    expect(await c.pb.collection("messages").getFullList({ filter: `room = "${dm.id}"` })).toHaveLength(0);
    await expectRejected(post(c, dm.id, "let me in"));
  });

  it("non-members' unfiltered subscriptions receive nothing from the DM", async () => {
    const { a, b, c, dm } = await trio();
    const cMsgs = await collect(c.pb, "messages");
    const cRooms = await collect(c.pb, "rooms");
    const bMsgs = await collect(b.pb, "messages", { filter: `room = "${dm.id}"` });
    await sleep(200);
    await post(a, dm.id, "psst");
    await sleep(500);
    expect(bMsgs.events.map((e) => e.record.text)).toEqual(["psst"]);
    expect(cMsgs.events).toEqual([]);
    expect(cRooms.events).toEqual([]); // not even the last_message_at update
    await Promise.all([cMsgs.stop(), cRooms.stop(), bMsgs.stop()]);
  });

  it("members can edit and soft-delete their own DM messages, not each other's", async () => {
    const { a, b, dm } = await trio();
    const m = await post(a, dm.id, "v1");
    expect((await a.pb.collection("messages").update(m.id, { text: "v2" })).text).toBe("v2");
    await expectRejected(b.pb.collection("messages").update(m.id, { text: "hijack" }));
    expect((await a.pb.collection("messages").update(m.id, { deleted: true })).deleted).toBe(true);
  });

  it("a non-member can't hide someone else's DM", async () => {
    const { a, c, dm } = await trio();
    await expectRejected(c.pb.collection("hidden_rooms").create({ user: c.user.id, room: dm.id }));
    expect((await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: dm.id })).room).toBe(dm.id);
  });
});

describe("DMs can't be made or changed through the rooms API (§16.3)", () => {
  it("rejects kind dm, members, dm_key and last_message_at on create", async () => {
    const a = await newUser();
    const b = await newUser();
    const base = { name: `r-${Date.now()}`, created_by: a.user.id };
    await expectRejected(a.pb.collection("rooms").create({ ...base, kind: "dm" }));
    await expectRejected(a.pb.collection("rooms").create({ ...base, members: [a.user.id, b.user.id] }));
    await expectRejected(a.pb.collection("rooms").create({ ...base, "members+": [b.user.id] }));
    // dm_key is a hidden field: PocketBase ignores it in non-superuser requests.
    const keyed = await a.pb.collection("rooms").create({ ...base, name: `${base.name}-k`, dm_key: `${a.user.id}:${b.user.id}` });
    expect(dmKeyOf(keyed.id)).toBe("");
    await expectRejected(a.pb.collection("rooms").create({ ...base, last_message_at: "2026-01-01 00:00:00.000Z" }));
    // and an explicit public room is fine
    expect((await a.pb.collection("rooms").create({ ...base, kind: "public" })).kind).toBe("public");
  });

  it("a public room's kind and members can't change, not even with modifiers", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    await expectRejected(a.pb.collection("rooms").update(room.id, { kind: "dm" }));
    await expectRejected(a.pb.collection("rooms").update(room.id, { members: [a.user.id, b.user.id] }));
    await expectRejected(a.pb.collection("rooms").update(room.id, { "members+": b.user.id }));
    await a.pb.collection("rooms").update(room.id, { dm_key: "k" });
    expect(dmKeyOf(room.id)).toBe("");
    expect((await a.pb.collection("rooms").getOne(room.id)).members).toEqual([]);
  });

  it("a DM can't be renamed, archived, or have its members changed, by either member", async () => {
    const { a, b, c, dm } = await trio();
    for (const u of [a, b]) {
      await expectRejected(u.pb.collection("rooms").update(dm.id, { name: "renamed" }));
      await expectRejected(u.pb.collection("rooms").update(dm.id, { archived: true }));
      await expectRejected(u.pb.collection("rooms").update(dm.id, { "members+": c.user.id }));
      await expectRejected(u.pb.collection("rooms").update(dm.id, { "members-": b.user.id }));
    }
    const after = await a.pb.collection("rooms").getOne(dm.id);
    expect(after.members).toEqual([a.user.id, b.user.id].sort());
    expect(after.archived).toBe(false);
  });

  it("the rooms API still requires a name for public rooms", async () => {
    const a = await newUser();
    await expectRejected(a.pb.collection("rooms").create({ name: "", created_by: a.user.id }));
    await expectRejected(a.pb.collection("rooms").create({ created_by: a.user.id }));
    const room = await newRoom(a);
    await expectRejected(a.pb.collection("rooms").update(room.id, { name: "  " }));
  });
});
