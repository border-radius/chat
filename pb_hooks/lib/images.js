/// <reference path="../../types/pocketbase.d.ts" />
// Image dimension limit for uploads (QA BUG-24). PocketBase decodes a whole image to thumbnail it, so a small,
// highly compressed file declaring huge dimensions can exhaust memory. Read the header of every upload in a format
// PocketBase thumbnails and refuse more than MAX_PIXELS. Pure byte parsing; no decoding.

/** 25 megapixels: about 125 MB to decode. The app's own uploads are at most 2048 px on a side (§15.3). */
const MAX_PIXELS = 25_000_000;

/** How much of a file to read looking for its dimensions (a JPEG's frame header can follow metadata segments). */
const HEADER_BYTES = 256 * 1024;

/**
 * @param {number[]} b
 * @param {number} i
 */
const u16be = (b, i) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
/**
 * @param {number[]} b
 * @param {number} i
 */
const u16le = (b, i) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
/**
 * @param {number[]} b
 * @param {number} i
 */
const u24le = (b, i) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
/**
 * @param {number[]} b
 * @param {number} i
 */
const u32be = (b, i) => (((b[i] ?? 0) << 24) >>> 0) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0));
/**
 * @param {number[]} b
 * @param {number} i
 * @param {string} s
 */
const ascii = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/**
 * Dimensions declared by a PNG, GIF, JPEG or WebP header; null for anything else.
 * `{ unreadable: true }` for an image whose dimensions couldn't be found in the bytes read.
 * @param {number[]} b
 * @returns {{ width: number, height: number } | { unreadable: true } | null}
 */
function imageSize(b) {
  if (ascii(b, 1, "PNG") && b[0] === 0x89) return { width: u32be(b, 16), height: u32be(b, 20) };
  if (ascii(b, 0, "GIF8")) return { width: u16le(b, 6), height: u16le(b, 8) };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
    if (ascii(b, 12, "VP8X")) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
    if (ascii(b, 12, "VP8L")) {
      const b1 = b[21] ?? 0;
      const b2 = b[22] ?? 0;
      const b3 = b[23] ?? 0;
      const b4 = b[24] ?? 0;
      return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
    }
    if (ascii(b, 12, "VP8 ")) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    return { unreadable: true };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the frame header (SOF0–SOF15, except DHT C4, JPG C8 and DAC CC).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return { unreadable: true };
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) {
        i++; // fill byte
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
      }
      if (marker === 0xd9 || marker === 0xda) return { unreadable: true }; // end of image / scan data before a frame
      i += 2 + u16be(b, i + 2);
    }
    return { unreadable: true };
  }
  return null;
}

/**
 * Refuse uploads in `field` that are images over the size limit (or whose dimensions can't be read).
 * @param {core.Record} record
 * @param {string} field
 */
function assertImagesFit(record, field) {
  for (const f of record.getUnsavedFiles(field)) {
    if (!f) continue;
    const reader = f.reader.open();
    let bytes;
    try {
      bytes = toBytes(reader, HEADER_BYTES);
    } finally {
      reader.close();
    }
    const size = imageSize(bytes);
    if (!size) continue;
    if ("unreadable" in size || size.width * size.height > MAX_PIXELS) {
      throw new BadRequestError("Failed to save record.", {
        [field]: new ValidationError("validation_image_too_large", `Images can be at most ${MAX_PIXELS / 1_000_000} megapixels.`),
      });
    }
  }
}

module.exports = { assertImagesFit, imageSize, MAX_PIXELS };
