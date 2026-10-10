import { describe, expect, it } from "vitest";
import { client, collect, eventually, newRoom, newUser, post, sleep } from "./helpers.ts";

const MSG_OPTS = (room: string) => ({
  filter: `room = "${room}"`,
  expand: "author",
  fields: "id,room,text,created,updated,edited_at,deleted,author,expand.author.id,expand.author.name",
});

describe("realtime (§5.5, §6)", () => {
  it("delivers creates in the subscribed room only, with author name and no email", async () => {
    const a = await newUser();
    const b = await newUser();
    const r1 = await newRoom(a);
    const r2 = await newRoom(a);
    const sub = await collect(b.pb, "messages", MSG_OPTS(r1.id));
    try {
      const m = await post(a, r1.id, "in r1");
      await post(a, r2.id, "in r2");

      await eventually(() => expect(sub.events).toHaveLength(1));
      const e = sub.events[0]!;
      expect(e.action).toBe("create");
      expect(e.record).toMatchObject({ id: m.id, text: "in r1" });
      expect(e.record.expand?.author).toEqual({ id: a.user.id, name: a.user.name });
      expect(JSON.stringify(e.record)).not.toContain("@test.local");

      await sleep(500);
      expect(sub.events).toHaveLength(1);
    } finally {
      await sub.stop();
    }
  });

  it("delivers edits and soft deletes as update events", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const m = await post(a, room.id, "v1");
    const sub = await collect(b.pb, "messages", MSG_OPTS(room.id));
    try {
      await a.pb.collection("messages").update(m.id, { text: "v2" });
      await a.pb.collection("messages").update(m.id, { deleted: true });

      await eventually(() => expect(sub.events).toHaveLength(2));
      expect(sub.events[0]).toMatchObject({ action: "update", record: { id: m.id, text: "v2", deleted: false } });
      expect(sub.events[0]!.record.edited_at).not.toBe("");
      expect(sub.events[1]).toMatchObject({ action: "update", record: { id: m.id, text: "", deleted: true } });
    } finally {
      await sub.stop();
    }
  });

  it("anonymous subscribers receive no message events", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const anon = client();
    const sub = await collect(anon, "messages");
    try {
      await post(a, room.id, "private-ish");
      await sleep(500);
      expect(sub.events).toHaveLength(0);
    } finally {
      await sub.stop();
    }
  });

  it("room updates (e.g. archiving) are delivered to subscribers", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const sub = await collect(b.pb, "rooms", { filter: `id = "${room.id}"` });
    try {
      await a.pb.collection("rooms").update(room.id, { archived: true });
      await eventually(() => expect(sub.events).toHaveLength(1));
      expect(sub.events[0]).toMatchObject({ action: "update", record: { id: room.id, archived: true } });
    } finally {
      await sub.stop();
    }
  });

  it("hidden_rooms subscriptions only deliver your own rows", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const subA = await collect(a.pb, "hidden_rooms");
    const subB = await collect(b.pb, "hidden_rooms");
    try {
      await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
      await eventually(() => expect(subA.events).toHaveLength(1));
      await sleep(300);
      expect(subB.events).toHaveLength(0);
    } finally {
      await subA.stop();
      await subB.stop();
    }
  });
});
