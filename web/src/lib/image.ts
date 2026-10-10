// Image preparation before upload (§15.3): scale down and re-encode, which also drops EXIF (GPS location).
// Best effort: anything that can't be decoded or re-encoded is uploaded as it is, and the server limits decide.

/** Types we re-encode. GIFs are left alone (re-encoding would drop the animation). */
const REENCODE = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Size of a `w`×`h` image scaled down (never up) so its longest edge is at most `maxEdge`. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function canvas(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement("canvas"), { width, height });
}

function encode(c: Canvas, type: string): Promise<Blob | null> {
  if ("convertToBlob" in c) return c.convertToBlob({ type, quality: 0.85 }).catch(() => null);
  return new Promise((ok) => c.toBlob(ok, type, 0.85));
}

/** `file` scaled to at most `maxEdge` px and re-encoded as WebP (JPEG where WebP can't be encoded). */
export async function prepareImage(file: File, maxEdge: number): Promise<File> {
  if (!REENCODE.has(file.type) || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const c = canvas(width, height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    // An encoder that doesn't support a type falls back to PNG: check what we actually got.
    let blob = await encode(c, "image/webp");
    if (blob?.type !== "image/webp") blob = await encode(c, "image/jpeg");
    if (!blob || (blob.type !== "image/webp" && blob.type !== "image/jpeg")) return file;
    const ext = blob.type === "image/webp" ? "webp" : "jpg";
    const base = file.name.replace(/\.[^.]*$/, "") || "image";
    return new File([blob], `${base}.${ext}`, { type: blob.type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
