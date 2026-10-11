// POST /api/chat/dms (§16.2) and the DM message hooks (§16.4).

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { adminClient, client, collect, eventually, newRoom, newUser, openDm, post, rawDb, status } from "./helpers.ts";

describe("POST /api/chat/dms (§16.2)", () => {
  it("creates the DM on first call and returns the same room afterwards, whoever asks", async () => {
    const a = await newUser("Ada");
    const b = await newUser("Bob");
    const dm = await openDm(a, b);
    expect(dm).toMatchObject({ kind: "dm", name: "", archived: false, created_by: a.user.id });
    expect(dm.members).toEqual([a.user.id, b.user.id].sort());
    expect(dm.expand!.members.map((m: { name: string }) => m.name).sort()).toEqual(["Ada", "Bob"]);
    expect(JSON.stringify(dm)).not.toContain("@test.local");
    expect(dm.dm_key).toBeUndefined();
    expect((await openDm(a, b)).id).toBe(dm.id);
    expect((await openDm(b, a)).id).toBe(dm.id);
  });

  it("concurrent calls for the same pair create one room", async () => {
    const a = await newUser();
    const b = await newUser();
    const rooms = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? openDm(a, b) : openDm(b, a))));
    expect(new Set(rooms.map((r) => r.id)).size).toBe(1);
    const db = rawDb();
    try {
      const n = db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE dm_key = ?").get([a.user.id, b.user.id].sort().join(":")) as {
        n: number;
      };
      expect(n.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects a missing, unknown or own user id, and anonymous callers", async () => {
    const a = await newUser();
    expect(await status(a.pb.send("/api/chat/dms", { method: "POST", body: {} }))).toBe(400);
    expect(await status(openDm(a, "nosuchuser00000"))).toBe(400);
    expect(await status(openDm(a, a))).toBe(400);
    expect(await status(client().send("/api/chat/dms", { method: "POST", body: { user: a.user.id } }))).toBe(401);
  });

  it("reopens the caller's closed DM (and only theirs)", async () => {
    const a = await newUser();
    const b = await newUser();
    const dm = await openDm(a, b);
    await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: dm.id });
    await b.pb.collection("hidden_rooms").create({ user: b.user.id, room: dm.id });
    await openDm(a, b);
    expect(await a.pb.collection("hidden_rooms").getFullList({ filter: `room = "${dm.id}"` })).toHaveLength(0);
    expect(await b.pb.collection("hidden_rooms").getFullList({ filter: `room = "${dm.id}"` })).toHaveLength(1);
  });

  describe("rate limit", () => {
    beforeAll(async () => {
      const admin = await adminClient();
      await admin.settings.update({ rateLimits: { ...inject("bootRateLimits"), enabled: true } });
    });
    afterAll(async () => {
      const admin = await adminClient();
      await admin.settings.update({ rateLimits: { ...inject("bootRateLimits"), enabled: false } });
    });

    it("is limited to 10 calls per minute", async () => {
      expect(inject("bootRateLimits").rules).toContainEqual(
        expect.objectContaining({ label: "POST /api/chat/dms", maxRequests: 10, duration: 60 }),
      );
      const [a, b] = await Promise.all([newUser(), newUser()]);
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push(await status(openDm(a, b)));
      expect(codes.slice(0, 10)).toEqual(Array(10).fill(200));
      expect(codes.slice(10)).toEqual([429, 429]);
    });
  });
});

describe("DM message hooks (§16.4)", () => {
  it("a DM message sets last_message_at, which both members receive live", async () => {
    const a = await newUser();
    const b = await newUser();
    const dm = await openDm(a, b);
    expect(dm.last_message_at).toBe("");
    const bRooms = await collect(b.pb, "rooms");
    const m = await post(a, dm.id, "hi");
    const room = await b.pb.collection("rooms").getOne(dm.id);
    expect(room.last_message_at).toBe(m.created);
    await eventually(() =>
      expect(bRooms.events).toContainEqual(
        expect.objectContaining({ action: "update", record: expect.objectContaining({ id: dm.id, last_message_at: m.created }) }),
      ),
    );
    await bRooms.stop();
  });

  it("reopens the DM for a recipient who closed it, live, and leaves the sender's closed state alone", async () => {
    const a = await newUser();
    const b = await newUser();
    const dm = await openDm(a, b);
    await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: dm.id });
    const bRow = await b.pb.collection("hidden_rooms").create({ user: b.user.id, room: dm.id });
    const bHidden = await collect(b.pb, "hidden_rooms");
    await post(a, dm.id, "are you there?"); // the hook runs after the create commits, before the response
    expect(await b.pb.collection("hidden_rooms").getFullList({ filter: `room = "${dm.id}"` })).toHaveLength(0);
    await eventually(() =>
      expect(bHidden.events).toContainEqual(
        expect.objectContaining({ action: "delete", record: expect.objectContaining({ id: bRow.id }) }),
      ),
    );
    expect(await a.pb.collection("hidden_rooms").getFullList({ filter: `room = "${dm.id}"` })).toHaveLength(1);
    await bHidden.stop();
  });

  it("public-room messages touch neither", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
    const b = await newUser();
    await b.pb.collection("hidden_rooms").create({ user: b.user.id, room: room.id });
    await post(a, room.id, "hello");
    expect((await a.pb.collection("rooms").getOne(room.id)).last_message_at).toBe("");
    expect(await b.pb.collection("hidden_rooms").getFullList({ filter: `room = "${room.id}"` })).toHaveLength(1);
  });
});
