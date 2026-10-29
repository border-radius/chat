// GET /api/chat/rooms and GET /api/chat/rooms/{room}/messages (pb_hooks/lib/lists.js, docs/API.md): the same answers
// the records API gives for the filters the clients used to write. Who sees what is checked by access.matrix.test.ts.

import type { RecordModel } from "pocketbase";
import { beforeAll, describe, expect, it } from "vitest";
import { client, newRoom, newUser, pngFile, post, status, type TestUser } from "./helpers.ts";

type Items = RecordModel[];

describe("the room list and message pages as routes", () => {
  let me: TestUser;
  let room: RecordModel;
  let sent: RecordModel[];

  beforeAll(async () => {
    me = await newUser();
    room = await newRoom(me);
    sent = [];
    for (let i = 1; i <= 7; i++) sent.push(await post(me, room.id, `m${i}`, i === 4 ? { files: [pngFile()] } : {}));
  });

  const route = (q: Record<string, string> = {}, who = me.pb, id = room.id) =>
    who.send<Items>(`/api/chat/rooms/${id}/messages`, { query: q });
  /** The records API's answer for the filter a client used to send. */
  const records = (filter: string, params: Record<string, string>, sort: string, perPage = 3) =>
    me.pb
      .collection("messages")
      .getList(1, perPage, {
        filter: me.pb.filter(`room = {:room}${filter ? ` && ${filter}` : ""}`, { room: room.id, ...params }),
        sort,
        skipTotal: true,
      })
      .then((l) => l.items.map((m) => m.id));
  const ids = (r: Items) => r.map((m) => m.id);

  it("lists the rooms the caller can see, by name, as the records API does", async () => {
    const all = (await me.pb.collection("rooms").getFullList({ sort: "name,id" })).map((r) => r.id);
    expect(ids(await me.pb.send<Items>("/api/chat/rooms", {}))).toEqual(all);
    const guest = client();
    const open = (await guest.collection("rooms").getFullList({ sort: "name,id" })).map((r) => r.id);
    expect(ids(await guest.send<Items>("/api/chat/rooms", {}))).toEqual(open);
  });

  it("gives each kind of page as the cursor filters did", async () => {
    const c = sent[3]!;
    const cur = { created: c.created, id: c.id };
    const cases: [Record<string, string>, string, Record<string, string>, string][] = [
      [{ kind: "latest" }, "", {}, "-created,-id"],
      [{}, "", {}, "-created,-id"],
      [{ kind: "first" }, "", {}, "created,id"],
      [{ kind: "older", ...cur }, "(created < {:created} || (created = {:created} && id < {:id}))", cur, "-created,-id"],
      [{ kind: "newer", ...cur }, "(created > {:created} || (created = {:created} && id > {:id}))", cur, "created,id"],
    ];
    for (const [q, filter, params, sort] of cases) {
      expect(ids(await route({ ...q, limit: "3" })), JSON.stringify(q)).toEqual(await records(filter, params, sort));
    }
    expect(ids(await route({ limit: "2", page: "2" }))).toEqual([sent[4]!.id, sent[3]!.id]);
    expect(await route()).toHaveLength(7);
  });

  it("only messages that may have attachments, with files=1", async () => {
    expect(ids(await route({ files: "1" }))).toEqual([sent[3]!.id]);
  });

  it("the changes since a time, oldest change first", async () => {
    const since = (await me.pb.collection("messages").getOne(sent[6]!.id)).updated;
    await new Promise((r) => setTimeout(r, 5));
    await me.pb.collection("messages").update(sent[5]!.id, { text: "edited" });
    await me.pb.collection("messages").update(sent[1]!.id, { text: "edited too" });
    const q = { kind: "changed", since, from: sent[0]!.created, to: sent[6]!.created };
    expect(ids(await route(q))).toEqual([sent[5]!.id, sent[1]!.id]);
  });

  it("takes ?expand and ?fields as the records API does", async () => {
    const items = await route({ limit: "1", expand: "author", fields: "id,text,expand.author.name" });
    expect(items).toEqual([{ id: sent[6]!.id, text: "m7", expand: { author: { name: me.user.name } } }]);
  });

  it("nothing from a room you can't see; refuses an unknown kind and a missing cursor", async () => {
    const other = await newUser();
    const priv = await other.pb.collection("rooms").update((await newRoom(other)).id, { visibility: "private" });
    expect(await route({}, me.pb, priv.id)).toEqual([]);
    expect(await route({}, me.pb, "nosuchroom0000")).toEqual([]);
    expect(await status(route({ kind: "sideways" }))).toBe(400);
    expect(await status(route({ kind: "older" }))).toBe(400);
  });

  it("caps limit at 200", async () => {
    const r = await newRoom(me);
    for (let i = 0; i < 201; i += 20) {
      await Promise.all(Array.from({ length: Math.min(20, 201 - i) }, (_, j) => post(me, r.id, `n${i + j}`)));
    }
    expect(await route({ limit: "500" }, me.pb, r.id)).toHaveLength(200);
  });
});
