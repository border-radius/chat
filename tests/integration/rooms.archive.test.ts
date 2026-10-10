import { describe, expect, it } from "vitest";
import { expectRejected, newRoom, newUser, uniq } from "./helpers.ts";

describe("room archiving (§5.2)", () => {
  it("archiving stamps archived_at and unarchiving clears it", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    expect(room.archived_at).toBe("");

    const archived = await a.pb.collection("rooms").update(room.id, { archived: true });
    expect(archived.archived).toBe(true);
    expect(archived.archived_at).not.toBe("");
    expect(Date.now() - Date.parse(archived.archived_at)).toBeLessThan(60_000);

    const restored = await a.pb.collection("rooms").update(room.id, { archived: false });
    expect(restored.archived).toBe(false);
    expect(restored.archived_at).toBe("");
  });

  it("renaming an archived room keeps archived_at unchanged", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const archived = await a.pb.collection("rooms").update(room.id, { archived: true });
    const renamed = await a.pb.collection("rooms").update(room.id, { name: `ren-${uniq()}` });
    expect(renamed.archived_at).toBe(archived.archived_at);
  });

  it("only the creator can archive or unarchive", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    await expectRejected(b.pb.collection("rooms").update(room.id, { archived: true }));
    await a.pb.collection("rooms").update(room.id, { archived: true });
    await expectRejected(b.pb.collection("rooms").update(room.id, { archived: false }));
    expect((await a.pb.collection("rooms").getOne(room.id)).archived).toBe(true);
  });

  it("an archived room's name is never reused, by a new room or a rename", async () => {
    const a = await newUser();
    const b = await newUser();
    const name = `kept-${uniq()}`;
    const room = await newRoom(a, name);
    await a.pb.collection("rooms").update(room.id, { archived: true });

    await expectRejected(newRoom(b, name));
    await expectRejected(newRoom(b, name.toUpperCase()));
    const other = await newRoom(b);
    await expectRejected(b.pb.collection("rooms").update(other.id, { name }));
  });

  it("an archived room is still listed and viewable", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    await a.pb.collection("rooms").update(room.id, { archived: true });
    expect((await b.pb.collection("rooms").getOne(room.id)).archived).toBe(true);
    expect(await b.pb.collection("rooms").getFullList({ filter: `id = "${room.id}"` })).toHaveLength(1);
  });
});
