// Server-side fixes from the third QA pass (docs/QA.md, BUG-35 … BUG-41): long upload names, control characters
// and whitespace in names, and legacy rooms whose names share a key.

import { describe, expect, it } from "vitest";
import { expectRejected, newRoom, newUser, rawDb, type TestUser, uniq } from "./helpers.ts";

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const textFile = (name: string) => new File(["hello"], name, { type: "text/plain" });

function withFiles(u: TestUser, room: string, files: File[]) {
  return u.pb.collection("messages").create({ room, author: u.user.id, text: "", files });
}

describe("long upload names (BUG-35, BUG-36)", () => {
  it("accepts a file whose non-Latin name is over 255 bytes, keeping a shortened name with its extension", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const long = `${"Протокол совещания ".repeat(8)}.pdf`; // 152 characters, 291 bytes: PocketBase used to fail it
    const m = await withFiles(a, room.id, [textFile(long), textFile(`${"😀".repeat(70)}.txt`)]);
    // In upload order: file_names is keyed by the stored (randomly suffixed) name, so its own order is arbitrary.
    const names = (m.files as string[]).map((f) => (m.file_names as Record<string, string>)[f] ?? "");
    expect(names).toHaveLength(2);
    for (const n of names) expect(utf8(n)).toBeLessThanOrEqual(200);
    expect(names[0]).toMatch(/^Протокол совещания .+\.pdf$/);
    expect(names[1]).toMatch(/^😀+\.txt$/u);
  });

  it("keeps the extension of a name cut at the length limit", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [textFile(`${"報告書".repeat(70)}.xlsx`)]);
    expect(Object.values(m.file_names as Record<string, string>)[0]).toMatch(/^(報告書)+報?告?\.xlsx$/);
  });

  it("accepts an avatar with a long non-Latin name", async () => {
    const a = await newUser();
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    const avatar = new File([png], `${"é".repeat(150)}.png`, { type: "image/png" });
    const u = await a.pb.collection("users").update(a.user.id, { avatar });
    expect(u.avatar).toMatch(/\.png$/);
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
