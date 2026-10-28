// The media grid's server side (§30.1): the `media` index kept by the messages hooks, GET /api/chat/media/{room}, the
// worker's thumbnails and video posters (POST /api/media/tick), and GET /api/chat/posters/{message}/{file}.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PocketBase, { type RecordModel } from "pocketbase";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { pngOf } from "../support/images.ts";
import { migrate, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { makeMp4 } from "../support/video.ts";
import { adminClient, client, newRoom, newUser, rawDb, type TestUser } from "./helpers.ts";

interface Item {
  message: string;
  source: string;
  file: string;
  pos: number;
  name: string;
  video: boolean;
  poster: boolean;
  sent: string;
  author: { id: string; name: string } | null;
}

const png = (name: string) => new File([new Uint8Array(pngOf(64, 48))], name, { type: "image/png" });
const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

/** A real one-second MP4, made with ffmpeg; null when there is no ffmpeg here (the poster tests are skipped, but not in CI). */
const mp4 = makeMp4();
/** A baseline JPEG's dimensions, from its frame header (SOF0). */
function jpegSize(b: Uint8Array) {
  for (let i = 2; i + 8 < b.length; i += 2 + ((b[i + 2]! << 8) | b[i + 3]!)) {
    if (b[i + 1] === 0xc0) return { width: (b[i + 7]! << 8) | b[i + 8]!, height: (b[i + 5]! << 8) | b[i + 6]! };
  }
  return null;
}
const video = (name: string) => new File([new Uint8Array(mp4 ?? [0])], name, { type: "video/mp4" });

async function send(u: TestUser, room: string, files: File[], text = "") {
  return u.pb.collection("messages").create({ room, author: u.user.id, text, files });
}

async function media(u: TestUser | null, room: string, query: Record<string, string | number> = {}) {
  const pb = u?.pb ?? client();
  return pb.send<{ items: Item[]; more: boolean }>(`/api/chat/media/${room}`, { query });
}

let admin: Awaited<ReturnType<typeof adminClient>>;
let messagesId = "";
const tick = () => admin.send("/api/media/tick", { method: "POST" });
const stored = (id: string, path: string) => existsSync(join(inject("pbDataDir"), "storage", messagesId, id, path));

beforeAll(async () => {
  admin = await adminClient();
  messagesId = (await admin.collections.getOne("messages")).id;
});

describe("GET /api/chat/media/{room} (§30.1)", () => {
  it("lists a room's images and videos newest first, a message's files last to first, a page at a time", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const first = await send(a, room.id, [png("one.png"), pdf("doc.pdf"), video("clip.mp4")]);
    await send(a, room.id, [pdf("only.pdf")], "no media");
    await a.pb.collection("messages").create({ room: room.id, author: a.user.id, text: "text only" });
    const last = await send(a, room.id, [png("two.png"), png("three.png")]);

    const { items, more } = await media(a, room.id);
    expect(more).toBe(false);
    expect(items.map((i) => i.name)).toEqual(["three.png", "two.png", "clip.mp4", "one.png"]);
    expect(items[0]).toMatchObject({ message: last.id, source: last.id, file: last.files[1], pos: 1, video: false, poster: false });
    expect(items[0]!.author).toEqual({ id: a.user.id, name: a.user.name });
    expect(items[0]!.sent).toBe(last.created);
    expect(items[2]).toMatchObject({ message: first.id, file: first.files[2], pos: 2, video: true });

    const page1 = await media(a, room.id, { limit: 3 });
    expect(page1.more).toBe(true);
    const end = page1.items.at(-1)!;
    const page2 = await media(a, room.id, { limit: 3, sent: end.sent, message: end.message, pos: end.pos });
    expect(page2).toEqual({ items: [items[3]], more: false });
  });

  it("shows a forward's media in its room, and drops a message's (and its forwards') when it is deleted", async () => {
    const a = await newUser();
    const from = await newRoom(a);
    const to = await newRoom(a);
    const original = await send(a, from.id, [png("pic.png")]);
    const [fwd] = await a.pb.send<RecordModel[]>("/api/chat/forward", { method: "POST", body: { messages: [original.id], room: to.id } });
    const shown = (await media(a, to.id)).items;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ message: fwd!.id, source: original.id, file: original.files[0], name: "pic.png" });

    await a.pb.collection("messages").update(original.id, { deleted: true });
    expect((await media(a, from.id)).items).toEqual([]);
    expect((await media(a, to.id)).items).toEqual([]);
  });

  it("is for whoever can see the room: 404 for a private room's outsiders and for guests outside Open Air", async () => {
    const a = await newUser();
    const b = await newUser();
    const priv = await a.pb.collection("rooms").create({ name: `p-${Date.now()}`, created_by: a.user.id, visibility: "private" });
    await send(a, priv.id, [png("secret.png")]);
    expect((await media(a, priv.id)).items).toHaveLength(1);
    await expect(media(b, priv.id)).rejects.toMatchObject({ status: 404 });
    await expect(media(null, priv.id)).rejects.toMatchObject({ status: 404 });

    const pub = await newRoom(a);
    await send(a, pub.id, [png("pub.png")]);
    await expect(media(null, pub.id)).rejects.toMatchObject({ status: 404 });
    const open = await a.pb.collection("rooms").create({ name: `o-${Date.now()}`, created_by: a.user.id, visibility: "open" });
    await send(a, open.id, [png("open.png")]);
    expect((await media(null, open.id)).items.map((i) => i.name)).toEqual(["open.png"]);
  });

  it("reads the index, not the room's messages (the query plan)", () => {
    const db = rawDb();
    try {
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT md.message FROM media md JOIN messages m ON m.id = md.message JOIN messages s ON s.id = md.source " +
            "WHERE md.room = 'r' AND (md.sent < 'x' OR (md.sent = 'x' AND md.message < 'y')) ORDER BY md.sent DESC, md.message DESC, md.pos DESC LIMIT 61",
        )
        .all()
        .map((r) => (r as { detail: string }).detail);
      expect(plan.join("\n")).toMatch(/SEARCH md USING INDEX idx_media_room/);
      expect(plan.join("\n")).not.toMatch(/TEMP B-TREE/);
    } finally {
      db.close();
    }
  });
});

describe("the media worker (§30.1)", () => {
  it("makes an image's thumbnails before anyone asks: all of a recent message's, the grid's for an older one", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await send(a, room.id, [png("new.png")]);
    const old = await send(a, room.id, [png("old.png")]);
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE media SET sent = '2025-01-01 00:00:00.000Z' WHERE message = ?").run(old.id);
    } finally {
      db.close();
    }
    const f = m.files[0];
    const o = old.files[0];
    expect(stored(m.id, `thumbs_${f}/240x240_${f}`)).toBe(false);
    await tick();
    for (const size of ["240x240", "800x480f", "480x240f"]) expect(stored(m.id, `thumbs_${f}/${size}_${f}`)).toBe(true);
    expect(stored(old.id, `thumbs_${o}/240x240_${o}`)).toBe(true);
    expect(stored(old.id, `thumbs_${o}/800x480f_${o}`)).toBe(false);
  });

  it.skipIf(!mp4 && !process.env.CI)("makes a video's poster, served to whoever may see the video, its forwards' readers too", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const m = await send(a, room.id, [video("clip.mp4")]);
    const file = m.files[0] as string;
    const url = (token: string, id = m.id) => `${inject("pbUrl")}/api/chat/posters/${id}/${file}${token ? `?token=${token}` : ""}`;
    expect((await fetch(url(await a.pb.files.getToken()))).status).toBe(404); // not made yet
    expect(m.file_dims).toEqual({}); // nor its shape, which is the poster's

    await tick();
    expect((await a.pb.collection("messages").getOne(m.id)).file_dims).toEqual({ [file]: [64, 48] });
    expect((await media(a, room.id)).items[0]).toMatchObject({ video: true, poster: true });
    const res = await fetch(url(await a.pb.files.getToken()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=2592000");
    const jpeg = new Uint8Array(await res.arrayBuffer());
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    // In the video's own shape, for the room's tiles (§17.5), and never enlarged: the clip is 64×48.
    expect(jpegSize(jpeg)).toEqual({ width: 64, height: 48 });
    // A public room: any signed-in user's file token, never none.
    expect((await fetch(url(await b.pb.files.getToken()))).status).toBe(200);
    expect((await fetch(url(""))).status).toBe(404);

    // A forward shows the poster from the start, and its readers get it under the original's id, as the file (§17.3).
    const dm = await b.pb.send<RecordModel>("/api/chat/dms", { method: "POST", body: { user: a.user.id } });
    await a.pb.send("/api/chat/forward", { method: "POST", body: { messages: [m.id], room: dm.id } });
    expect((await media(b, dm.id)).items[0]).toMatchObject({ source: m.id, poster: true });

    // Deleted: the poster goes with the file.
    await a.pb.collection("messages").update(m.id, { deleted: true });
    expect((await fetch(url(await a.pb.files.getToken()))).status).toBe(404);
    expect(stored(m.id, `thumbs_${file}/poster.jpg`)).toBe(false);
  });

  it.skipIf(!mp4 && !process.env.CI)("keeps a private room's poster to its members", async () => {
    const a = await newUser();
    const b = await newUser();
    const priv = await a.pb.collection("rooms").create({ name: `p-${Date.now()}`, created_by: a.user.id, visibility: "private" });
    const m = await send(a, priv.id, [video("clip.mp4")]);
    await tick();
    const url = async (u: TestUser) => `${inject("pbUrl")}/api/chat/posters/${m.id}/${m.files[0]}?token=${await u.pb.files.getToken()}`;
    expect((await fetch(await url(a))).status).toBe(200);
    expect((await fetch(await url(b))).status).toBe(404);
  });

  it("records the shapes of files sent before messages kept them (§17.5), each file once", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await send(a, room.id, [png("a.png"), pdf("a.pdf"), png("b.png")]);
    const [f0, , f2] = m.files as string[];
    expect(m.file_dims).toEqual({ [f0!]: [64, 48], [f2!]: [64, 48] });
    await tick();
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE messages SET file_dims = 'null' WHERE id = ?").run(m.id);
      db.prepare("UPDATE media SET sized = FALSE WHERE message = ?").run(m.id);
    } finally {
      db.close();
    }
    const before = await a.pb.collection("messages").getOne(m.id);
    expect(before.file_dims).toBeNull();
    await tick();
    const after = await a.pb.collection("messages").getOne(m.id);
    expect(after.file_dims).toEqual({ [f0!]: [64, 48], [f2!]: [64, 48] });
    expect(after.updated).toBe(before.updated); // not a save: nothing else changes
    const check = rawDb();
    try {
      expect(check.prepare("SELECT sized FROM media WHERE message = ?").all(m.id)).toEqual([{ sized: 1 }, { sized: 1 }]);
    } finally {
      check.close();
    }
  });

  it("gives a file that isn't a video, or not the message's, no poster", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await send(a, room.id, [png("p.png")]);
    const token = await a.pb.files.getToken();
    for (const path of [`${m.id}/${m.files[0]}`, `${m.id}/other_abcdefghij.mp4`, `nope/${m.files[0]}`]) {
      expect((await fetch(`${inject("pbUrl")}/api/chat/posters/${path}?token=${token}`)).status).toBe(404);
    }
  });
});

describe("migration 1760000029_media.js", () => {
  it("indexes the messages there already are: media only, a forward's from its original, none of deleted ones", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "media-migration-"));
    let server = await startPocketBase({ dataDir });
    try {
      const pb = new PocketBase(server.url);
      pb.autoCancellation(false);
      const email = "mig@test.local";
      const su = new PocketBase(server.url);
      await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      await su.collection("users").create({ email, password: "password-123", passwordConfirm: "password-123", name: "Mig" });
      const { record: me } = await pb.collection("users").authWithPassword(email, "password-123");
      const room = await pb.collection("rooms").create({ name: "mig-a", created_by: me.id });
      const other = await pb.collection("rooms").create({ name: "mig-b", created_by: me.id });
      const create = (r: string, files: File[]) => pb.collection("messages").create({ room: r, author: me.id, files });
      const a = await create(room.id, [png("a.png"), pdf("a.pdf"), video("a.mp4")]);
      const gone = await create(room.id, [png("gone.png")]);
      await pb.collection("messages").update(gone.id, { deleted: true });
      await pb.send("/api/chat/forward", { method: "POST", body: { messages: [a.id], room: other.id } });
      await server.stop();

      migrate(dataDir, "down", "1");
      migrate(dataDir, "up");
      const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT room, message, source, file, pos, video, sent, ready, poster, length(id) AS n FROM media").all();
        const fwd = (db.prepare("SELECT id FROM messages WHERE forward_of = ?").get(a.id) as { id: string }).id;
        const row = (r: string, message: string, pos: number, ready: number) => ({
          room: r,
          message,
          source: a.id,
          file: a.files[pos],
          pos,
          video: pos === 2 ? 1 : 0,
          ready,
          poster: 0,
          n: 15,
        });
        expect(rows.map(({ sent, ...r }) => r)).toEqual(
          expect.arrayContaining([row(room.id, a.id, 0, 0), row(room.id, a.id, 2, 0), row(other.id, fwd, 0, 1), row(other.id, fwd, 2, 1)]),
        );
        expect(rows).toHaveLength(4);
        expect(rows.filter((r) => r.message === a.id).map((r) => r.sent)).toEqual([a.created, a.created]);
      } finally {
        db.close();
      }
      server = await startPocketBase({ dataDir });
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
