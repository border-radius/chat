// The media worker with files kept in S3 (§30.1): a video is copied to the temp folder for ffmpeg, its poster stored
// in the bucket next to it, and the copy removed. Collections (§31) copy files out of the bucket and back the same way. Its own PocketBase, on an S3 server (versitygw, tests/support/s3.ts).
// Skipped without versitygw or ffmpeg, except in CI, which installs both.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PocketBase from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pngOf } from "../support/images.ts";
import { disableRateLimits, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { hasS3Server, type S3Server, startS3 } from "../support/s3.ts";
import { makeMp4 } from "../support/video.ts";

const mp4 = makeMp4();
const run = !!process.env.CI || (!!mp4 && hasS3Server());

describe.skipIf(!run)("media worker, files in S3 (§30.1)", () => {
  let s3: S3Server;
  let server: PocketBaseServer;
  let su: PocketBase;
  let pb: PocketBase;
  let me = "";
  let messagesId = "";
  /** The PocketBase process's temp folder (TMPDIR), where the video copies go. */
  const temp = mkdtempSync(join(tmpdir(), "chat-pb-tmp-"));

  beforeAll(async () => {
    s3 = await startS3();
    server = await startPocketBase({ env: { TMPDIR: temp } });
    await disableRateLimits(server.url);
    su = new PocketBase(server.url);
    su.autoCancellation(false);
    await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
    await su.settings.update({
      s3: {
        enabled: true,
        bucket: s3.bucket,
        region: "us-east-1",
        endpoint: s3.endpoint,
        accessKey: s3.accessKey,
        secret: s3.secret,
        forcePathStyle: true,
      },
    });
    messagesId = (await su.collections.getOne("messages")).id;
    await su.collection("users").create({ email: "s3@test.local", password: "password-123", passwordConfirm: "password-123", name: "S3" });
    pb = new PocketBase(server.url);
    pb.autoCancellation(false);
    me = (await pb.collection("users").authWithPassword("s3@test.local", "password-123")).record.id;
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await s3?.stop();
    rmSync(temp, { recursive: true, force: true });
  });

  const inBucket = (id: string, path: string) => existsSync(join(s3.dir, messagesId, id, path));

  it("makes a video's poster from a temp copy, keeps it in the bucket, and leaves no copy behind", async () => {
    const room = await pb.collection("rooms").create({ name: "s3-room", created_by: me });
    const m = await pb.collection("messages").create({
      room: room.id,
      author: me,
      files: [
        new File([new Uint8Array(mp4 ?? [0])], "clip.mp4", { type: "video/mp4" }),
        new File([new Uint8Array(pngOf(64, 48))], "pic.png"),
      ],
    });
    const [clip, pic] = m.files as [string, string];
    expect(inBucket(m.id, clip)).toBe(true); // really in S3, not in pb_data/storage
    expect(existsSync(join(server.dataDir, "storage", messagesId, m.id))).toBe(false);

    await su.send("/api/media/tick", { method: "POST" });
    expect(inBucket(m.id, `thumbs_${clip}/poster.jpg`)).toBe(true);
    expect(inBucket(m.id, `thumbs_${pic}/240x240_${pic}`)).toBe(true);
    expect(readdirSync(temp).filter((f) => f.startsWith("chat-poster-"))).toEqual([]);

    const { items } = await pb.send<{ items: { file: string; poster: boolean }[] }>(`/api/chat/media/${room.id}`, {});
    expect(items.find((i) => i.file === clip)?.poster).toBe(true);
    const res = await fetch(`${server.url}/api/chat/posters/${m.id}/${clip}?token=${await pb.files.getToken()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const jpeg = new Uint8Array(await res.arrayBuffer());
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);

    // Deleted: PocketBase removes the file's thumbs folder from the bucket, the poster with it.
    await pb.collection("messages").update(m.id, { deleted: true });
    expect(inBucket(m.id, `thumbs_${clip}/poster.jpg`)).toBe(false);
  });

  it("saves a video to a collection, poster and all, attaches it back, and leaves no copy behind (§31)", async () => {
    const room = await pb.collection("rooms").create({ name: "s3-collections", created_by: me });
    const m = await pb.collection("messages").create({
      room: room.id,
      author: me,
      files: [new File([new Uint8Array(mp4 ?? [0])], "clip.mp4", { type: "video/mp4" })],
    });
    await su.send("/api/media/tick", { method: "POST" });
    const coll = await pb.collection("collections").create({ owner: me, name: "s3" });
    const item = await pb.send<{ id: string; file: string; poster: boolean }>("/api/chat/items", {
      method: "POST",
      body: { collection: coll.id, message: m.id, file: m.files[0] },
    });
    expect(item.poster).toBe(true);
    const itemsId = (await su.collections.getOne("collection_items")).id;
    expect(existsSync(join(s3.dir, itemsId, item.id, item.file))).toBe(true);
    expect(existsSync(join(s3.dir, itemsId, item.id, `thumbs_${item.file}/poster.jpg`))).toBe(true);

    const sent = await pb.collection("messages").create({ room: room.id, author: me, items: JSON.stringify([item.id]) });
    expect(inBucket(sent.id, sent.files[0])).toBe(true);
    expect(sent.file_names[sent.files[0]]).toBe("clip.mp4");
    expect(readdirSync(temp).filter((f) => f.startsWith("chat-poster-"))).toEqual([]);
  });
});
