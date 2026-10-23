// BUG-24: images whose declared dimensions would make thumbnailing exhaust server memory are refused.

import { describe, expect, it } from "vitest";
import { gifHeader, jpegHeader, pngHeader, pngOf, webpHeader } from "../support/images.ts";
import { expectRejected, newRoom, newUser, status, uniq } from "./helpers.ts";

const file = (bytes: Buffer, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });
const BIG = 30_000;

describe("image size limit (BUG-24)", () => {
  it("rejects an avatar declaring 30000×30000, with an avatar field error", async () => {
    const a = await newUser();
    const err = await a.pb
      .collection("users")
      .update(a.user.id, { avatar: file(pngHeader(BIG, BIG), "bomb.png", "image/png") })
      .catch((e: { status: number; response: { data: Record<string, { code: string }> } }) => e);
    expect((err as { status: number }).status).toBe(400);
    expect((err as { response: { data: Record<string, { code: string }> } }).response.data.avatar?.code).toBe("validation_image_too_large");
  });

  it("rejects attachments in every thumbnailed format: PNG, GIF, JPEG and WebP", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const send = (f: File) => a.pb.collection("messages").create({ room: room.id, author: a.user.id, text: "x", files: [f] });
    await expectRejected(send(file(pngHeader(BIG, BIG), "a.png", "image/png")));
    await expectRejected(send(file(gifHeader(65_535, 65_535), "a.gif", "image/gif")));
    await expectRejected(send(file(jpegHeader(BIG, BIG), "a.jpg", "image/jpeg")));
    await expectRejected(send(file(jpegHeader(BIG, BIG, 100_000), "padded.jpg", "image/jpeg")));
    await expectRejected(send(file(webpHeader(BIG, BIG), "a.webp", "image/webp")));
    // one bad file fails the whole message
    await expectRejected(
      a.pb.collection("messages").create({
        room: room.id,
        author: a.user.id,
        text: "x",
        files: [file(pngOf(10, 10), "ok.png", "image/png"), file(pngHeader(BIG, BIG), "bad.png", "image/png")],
      }),
    );
  });

  it("rejects uploads into a collection in every thumbnailed format, and keeps ordinary ones (BUG-140)", async () => {
    const a = await newUser();
    const coll = await a.pb.collection("collections").create({ owner: a.user.id, name: `c-${uniq()}` });
    const up = (f: File) => a.pb.send("/api/chat/items", { method: "POST", body: { collection: coll.id, file: f } });
    const err = await up(file(pngHeader(BIG, BIG), "bomb.png", "image/png")).catch(
      (e: { status: number; response: { data: Record<string, { code: string }> } }) => e,
    );
    expect((err as { status: number }).status).toBe(400);
    expect((err as { response: { data: Record<string, { code: string }> } }).response.data.file?.code).toBe("validation_image_too_large");
    await expectRejected(up(file(gifHeader(65_535, 65_535), "a.gif", "image/gif")));
    await expectRejected(up(file(jpegHeader(BIG, BIG), "a.jpg", "image/jpeg")));
    await expectRejected(up(file(webpHeader(BIG, BIG), "a.webp", "image/webp")));
    expect(await status(up(file(pngHeader(5000, 5000), "max.png", "image/png")))).toBe(200);
    expect((await a.pb.collection("collections").getOne(coll.id)).items).toBe(1);
  });

  it("accepts ordinary images up to 25 megapixels, and non-images regardless of content", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const send = (f: File) => a.pb.collection("messages").create({ room: room.id, author: a.user.id, text: "x", files: [f] });
    expect(await status(send(file(pngOf(2048, 1536), "photo.png", "image/png")))).toBe(200);
    expect(await status(send(file(pngHeader(5000, 5000), "max.png", "image/png")))).toBe(200);
    expect(await status(send(file(jpegHeader(4000, 3000), "photo.jpg", "image/jpeg")))).toBe(200);
    expect(await status(send(file(Buffer.from("%PDF-1.4 not an image"), "doc.pdf", "application/pdf")))).toBe(200);
    expect(await status(a.pb.collection("users").update(a.user.id, { avatar: file(pngOf(512, 512), "me.png", "image/png") }))).toBe(200);
  });
});
