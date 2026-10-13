// Display names and room names (§5.1, §5.2, §22.1): cleaned of invisible and control characters, unique however they are
// written (case, script, look-alikes), and room names without their "#" (QA BUG-10, 11, 12, 38, 41, 48).
// The cleaning is pb_hooks/lib/text.js; the uniqueness check is setNameKey in pb_hooks/lib/records.js.

import { ClientResponseError } from "pocketbase";
import { describe, expect, it } from "vitest";
import { client, expectRejected, newRoom, newUser, post, rawDb, uniq } from "./helpers.ts";

const signUp = (name: string) =>
  client()
    .collection("users")
    .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name });

/** The field error code a rejected save reports for `field`. */
async function codeOf(p: Promise<unknown>, field: string): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ClientResponseError) return (e.response.data as Record<string, { code?: string }>)[field]?.code;
    throw e;
  }
  return undefined;
}

describe("invisible text (BUG-10, BUG-11)", () => {
  it("rejects messages made only of zero-width characters, on create and on edit", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await expectRejected(post(a, room.id, "​"));
    await expectRejected(post(a, room.id, "​⁠﻿ ‍"));
    const m = await post(a, room.id, "visible");
    await expectRejected(a.pb.collection("messages").update(m.id, { text: "​" }));
  });

  it("keeps joiners inside real text (emoji sequences, scripts that need ZWJ/ZWNJ)", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const family = "👨‍👩‍👧";
    expect((await post(a, room.id, family)).text).toBe(family);
  });

  it("rejects display names and room names made only of invisible characters", async () => {
    await expectRejected(signUp("​"));
    await expectRejected(signUp("‮​"));
    const a = await newUser();
    await expectRejected(a.pb.collection("rooms").create({ name: "​﻿", created_by: a.user.id }));
  });

  it("strips bidi overrides and zero-width spaces from names", async () => {
    expect((await signUp("‮admin")).name).toBe("admin");
    const a = await newUser();
    const n = `r${uniq()}`;
    const room = await a.pb.collection("rooms").create({ name: `${n}​`, created_by: a.user.id });
    expect(room.name).toBe(n);
  });
});

describe("room names are unique ignoring case, in any script (BUG-12)", () => {
  it("rejects names that differ only in non-ASCII case, case folding or invisible characters", async () => {
    const a = await newUser();
    const n = uniq();
    await newRoom(a, `Über-${n}`);
    expect(await codeOf(a.pb.collection("rooms").create({ name: `über-${n}`, created_by: a.user.id }), "name")).toBe(
      "validation_not_unique",
    );
    await newRoom(a, `straße-${n}`);
    await expectRejected(a.pb.collection("rooms").create({ name: `STRASSE-${n}`, created_by: a.user.id }));
    await newRoom(a, `general-${n}`);
    await expectRejected(a.pb.collection("rooms").create({ name: `general-${n}⁠`, created_by: a.user.id }));
  });

  it("a rename can't take another room's name, but can change the case of its own", async () => {
    const a = await newUser();
    const n = uniq();
    await newRoom(a, `Ärger-${n}`);
    const mine = await newRoom(a, `other-${n}`);
    expect(await codeOf(a.pb.collection("rooms").update(mine.id, { name: `ärger-${n}` }), "name")).toBe("validation_not_unique");
    expect((await a.pb.collection("rooms").update(mine.id, { name: `OTHER-${n}` })).name).toBe(`OTHER-${n}`);
  });

  it("the uniqueness key never leaves the server", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const seen = await a.pb.collection("rooms").getOne(room.id);
    expect(seen).not.toHaveProperty("name_key");
    // Not filterable either (hidden fields are superuser-only): rejected, or simply no match.
    const res = await a.pb
      .collection("rooms")
      .getList(1, 1, { filter: `name_key = "${room.name}"` })
      .catch(() => null);
    expect(res?.items ?? []).toHaveLength(0);
  });
});

describe("control characters and whitespace in names (BUG-38)", () => {
  it("turns line breaks, tabs and runs of spaces in room names into single spaces", async () => {
    const a = await newUser();
    const n = uniq();
    const room = await a.pb.collection("rooms").create({ name: `  two\nlines\t${n}  `, created_by: a.user.id });
    expect(room.name).toBe(`two lines ${n}`);
    // Look-alikes of an existing name are the same name.
    await expectRejected(a.pb.collection("rooms").create({ name: `two  lines ${n}`, created_by: a.user.id }));
    await expectRejected(a.pb.collection("rooms").create({ name: `two\u00a0lines\u2028${n}`, created_by: a.user.id }));
  });

  it("cleans display names the same way, and rejects one made only of control characters", async () => {
    const a = await newUser();
    const u = await a.pb.collection("users").update(a.user.id, { name: "Ada\n\n  Lovelace\u0007" });
    expect(u.name).toBe("Ada Lovelace");
    await expectRejected(a.pb.collection("users").update(a.user.id, { name: "\n\t\u0000" }));
  });
});

describe("legacy rooms whose names share a key (BUG-41)", () => {
  it("can still be archived and unarchived; renaming one onto the other is still refused", async () => {
    const a = await newUser();
    const n = uniq();
    await newRoom(a, `Über ${n}`);
    const legacy = await newRoom(a, `other ${n}`);
    // As left by 1760000001_qa_fixes.js for names that already clashed: the key made unique with the room id.
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE rooms SET name = ?, name_key = ? WHERE id = ?").run(`über ${n}`, `über ${n}#${legacy.id}`, legacy.id);
    } finally {
      db.close();
    }
    const rooms = a.pb.collection("rooms");
    expect((await rooms.update(legacy.id, { archived: true })).archived).toBe(true);
    expect((await rooms.update(legacy.id, { archived: false })).archived).toBe(false);
    await expectRejected(rooms.update(legacy.id, { name: `ÜBER ${n}` }));
  });

  it("a client can't set name_key, even without changing the name", async () => {
    const a = await newUser();
    const n = `room-${uniq()}`;
    const room = await newRoom(a, n);
    await a.pb.collection("rooms").update(room.id, { name_key: "something else" });
    const db = rawDb();
    try {
      expect(db.prepare("SELECT name_key FROM rooms WHERE id = ?").get(room.id)).toEqual({ name_key: n });
    } finally {
      db.close();
    }
  });
});

describe("room names typed with their # (BUG-48)", () => {
  it("drops leading #s, so “#name” is the room “name”, shown as #name", async () => {
    const a = await newUser();
    const name = `hash-${uniq()}`;
    const room = await a.pb.collection("rooms").create({ name: `## ${name}`, created_by: a.user.id });
    expect(room.name).toBe(name);
    await expectRejected(a.pb.collection("rooms").create({ name, created_by: a.user.id }));
    await expectRejected(a.pb.collection("rooms").create({ name: " # ", created_by: a.user.id }));
    // A # inside the name stays.
    const inner = await a.pb.collection("rooms").create({ name: `c#-${uniq()}`, created_by: a.user.id });
    expect(inner.name).toMatch(/^c#-/);
  });
});
