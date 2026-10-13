// Message attachments (§17): rules, hooks, protected access, serving headers.

import { describe, expect, it } from "vitest";
import { expectRejected, newRoom, newUser, openDm, pngFile, post, type TestUser } from "./helpers.ts";

const utf8 = (s: string) => new TextEncoder().encode(s).length;

const textFile = (name: string) => new File(["hello"], name, { type: "text/plain" });

const file = (name: string, type: string, bytes: number | string = "x") =>
  new File([typeof bytes === "number" ? new Uint8Array(bytes) : bytes], name, { type });

async function withFiles(u: TestUser, room: string, files: File[], text = "") {
  return u.pb.collection("messages").create({ room, author: u.user.id, text, files });
}

/** Status of a file download as `u` (with a fresh file token), or anonymously without one. */
async function fetchFile(
  u: TestUser | null,
  owner: TestUser,
  record: { id: string; collectionName: string },
  name: string,
  thumb?: string,
) {
  const token = u ? await u.pb.files.getToken() : "";
  const url = owner.pb.files.getURL(record, name, { ...(token ? { token } : {}), ...(thumb ? { thumb } : {}) });
  return fetch(url);
}

describe("attachments (§17.1)", () => {
  it("a message may carry files and no text; text-less and file-less is still rejected", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile("photo.png"), file("notes.txt", "text/plain")], "  ");
    expect(m.text).toBe("");
    expect(m.files).toHaveLength(2);
    expect(m.files[0]).toMatch(/^photo_\w{10}\.png$/);
    await expectRejected(post(a, room.id, "   "));
    await expectRejected(withFiles(a, room.id, [], " ​ "));
  });

  it("rejects an 11th file and files over 20 MB", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await expectRejected(
      withFiles(
        a,
        room.id,
        Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`, "text/plain")),
      ),
    );
    await expectRejected(withFiles(a, room.id, [file("big.bin", "application/octet-stream", 20 * 1024 * 1024 + 1)]));
  });

  it("accepts 10 files of 20 MB in one message (the request body limit fits), and other requests keep 32 MB", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(
      a,
      room.id,
      Array.from({ length: 10 }, (_, i) => file(`b${i}.bin`, "application/octet-stream", 20 * 1024 * 1024)),
    );
    expect(m.files).toHaveLength(10);
    // An avatar is not a message: PocketBase's default limit still holds.
    const big = new FormData();
    big.append("avatar", file("big.png", "image/png", 33 * 1024 * 1024));
    const res = await fetch(`${a.pb.baseURL}/api/collections/users/records/${a.user.id}`, {
      method: "PATCH",
      headers: { Authorization: a.pb.authStore.token },
      body: big,
    });
    expect(res.status).toBe(413);
  }, 60_000);

  it("attachments can't be added, removed or replaced by an edit; a text edit keeps them", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile()], "caption");
    const msgs = a.pb.collection("messages");
    await expectRejected(msgs.update(m.id, { files: [pngFile("other.png")] }));
    await expectRejected(msgs.update(m.id, { "files+": [pngFile("more.png")] }));
    await expectRejected(msgs.update(m.id, { "files-": [m.files[0]] }));
    await expectRejected(msgs.update(m.id, { files: [] }));
    const edited = await msgs.update(m.id, { text: "new caption" });
    expect(edited.files).toEqual(m.files);
    expect((await msgs.update(m.id, { text: "" })).text).toBe(""); // text optional next to an attachment
  });

  it("soft delete removes the attachments, and their URLs stop working", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile()], "bye");
    expect((await fetchFile(a, a, m, m.files[0])).status).toBe(200);
    const deleted = await a.pb.collection("messages").update(m.id, { deleted: true });
    expect(deleted.files).toEqual([]);
    expect((await fetchFile(a, a, m, m.files[0])).status).toBe(404);
  });

  it("archived rooms take no attachments", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await a.pb.collection("rooms").update(room.id, { archived: true });
    await expectRejected(withFiles(a, room.id, [pngFile()]));
  });
});

describe("protected access (§17.3)", () => {
  it("needs a file token; a non-member's token can't open a DM's file", async () => {
    const [a, b, c] = await Promise.all([newUser(), newUser(), newUser()]);
    const dm = await openDm(a, b);
    const m = await withFiles(a, dm.id, [pngFile()], "just us");
    const name = m.files[0] as string;
    expect([403, 404]).toContain((await fetchFile(null, a, m, name)).status);
    expect((await fetchFile(a, a, m, name)).status).toBe(200);
    expect((await fetchFile(b, a, m, name, "800x480f")).status).toBe(200);
    expect([403, 404]).toContain((await fetchFile(c, a, m, name)).status);
  });

  it("public-room files open for any logged-in user with a token", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile()]);
    expect((await fetchFile(b, a, m, m.files[0], "480x240f")).status).toBe(200);
  });

  it("an uploaded .html or .svg is served inert: sandbox CSP and nosniff", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [
      file("page.html", "text/html", "<script>window.top.__pwned=1</script>"),
      file("pic.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ]);
    for (const name of m.files as string[]) {
      const res = await fetchFile(a, a, m, name);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("original file names (QA BUG-28)", () => {
  it("the server records each upload's original name, keyed by its stored name", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [file("Quarterly Report (final).pdf", "application/pdf"), pngFile("Ünïcødé photo.png")]);
    expect(m.files[0]).toMatch(/^quarterly_report_final_\w{10}\.pdf$/);
    expect(m.file_names).toEqual({ [m.files[0]]: "Quarterly Report (final).pdf", [m.files[1]]: "Ünïcødé photo.png" });
  });

  it("clients can't forge or change the names; spoofing characters are dropped; a delete clears them", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const forged = await a.pb.collection("messages").create({
      room: room.id,
      author: a.user.id,
      text: "",
      files: [file("invoice‮fdp.exe", "application/octet-stream")],
      file_names: { x: "y" },
    });
    expect(Object.values(forged.file_names)).toEqual(["invoicefdp.exe"]);
    const edited = await a.pb.collection("messages").update(forged.id, { text: "now", file_names: { [forged.files[0]]: "nice.pdf" } });
    expect(edited.file_names).toEqual(forged.file_names);
    expect((await a.pb.collection("messages").update(forged.id, { deleted: true })).file_names).toEqual({});
  });

  it("messages without files have no names", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    expect((await post(a, room.id, "plain")).file_names).toEqual({});
  });
});

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
});

describe("attachment names keep their double quotes (BUG-54)", () => {
  it('stores "Q&A "v2".txt", which browsers send as "Q&A %22v2%22.txt"', async () => {
    const u = await newUser();
    const room = await newRoom(u);
    const name = 'Q&A "v2" notes.txt';
    const m = await u.pb.collection("messages").create({ room: room.id, author: u.user.id, text: "", files: [new File(["x"], name)] });
    expect(Object.values(m.file_names as Record<string, string>)).toEqual([name]);
  });
});
