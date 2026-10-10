// Image headers for upload-limit tests (BUG-24): tiny files that declare huge dimensions.

import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A valid grayscale PNG of w×h (all black; compresses to almost nothing — keep w×h modest). */
export function pngOf(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth, colour type 0 (grayscale)
  const raw = Buffer.alloc((w + 1) * h);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG header declaring w×h (the image data is a stub: enough for header checks, not for decoding). */
export function pngHeader(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(64))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function gifHeader(w: number, h: number): Buffer {
  const b = Buffer.from("GIF89a\0\0\0\0\0\0\0", "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return Buffer.concat([b, Buffer.from([0x3b])]);
}

/** A baseline JPEG header (SOI, APP0, SOF0 with w×h) after `padding` bytes of APP segments. */
export function jpegHeader(w: number, h: number, padding = 0): Buffer {
  const parts = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  parts.push(app0);
  for (let left = padding; left > 0; left -= 65533) {
    const n = Math.min(65533, left);
    const seg = Buffer.alloc(n + 4);
    seg[0] = 0xff;
    seg[1] = 0xe2;
    seg.writeUInt16BE(n + 2, 2);
    parts.push(seg);
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** An extended WebP (VP8X) header declaring w×h. */
export function webpHeader(w: number, h: number): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const body = Buffer.concat([Buffer.from("WEBPVP8X", "latin1"), Buffer.from([10, 0, 0, 0]), vp8x]);
  const riff = Buffer.from("RIFF\0\0\0\0", "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
