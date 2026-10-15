// Picking files to send or to use as an avatar, and preparing images first (§15.3): scaled down and re-encoded, which
// also drops EXIF (GPS location). Best effort, as on the web: anything that can't be re-encoded is sent as it is.

import * as DocumentPicker from "expo-document-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { fitWithin, isVideo, type LocalFile } from "../shared";
import type { NativeFile } from "./client";

/** Longest edge of an attached image after preparation (as the web composer). */
export const IMAGE_EDGE = 2048;
/** Longest edge of an avatar (§15.3). */
export const AVATAR_EDGE = 512;

const REENCODE = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** A name for a picked file that has none (the camera, some galleries). */
const nameFor = (uri: string, type: string) => {
  const fromUri = decodeURIComponent(uri.split(/[/?#]/).filter(Boolean).pop() ?? "");
  if (fromUri.includes(".")) return fromUri;
  const ext = Object.entries(TYPES).find(([, t]) => t === type)?.[0] ?? "bin";
  return `${type.split("/")[0] || "file"}-${Date.now()}.${ext}`;
};

/**
 * `f` scaled to at most `maxEdge` px and re-encoded: PNG as PNG (keeps transparency), the rest (HEIC included) as JPEG,
 * which PocketBase thumbnails in kind. GIFs are left alone (re-encoding would drop the animation).
 */
export async function prepareImage(f: NativeFile, maxEdge: number, size?: { width: number; height: number }): Promise<NativeFile> {
  if (!REENCODE.has(f.type)) return f;
  try {
    let ctx = ImageManipulator.manipulate(f.uri);
    // Without its size (never from the pickers), it is only re-encoded.
    if (size && Math.max(size.width, size.height) > maxEdge) ctx = ctx.resize(fitWithin(size.width, size.height, maxEdge));
    const image = await ctx.renderAsync();
    const png = f.type === "image/png";
    const saved = await image.saveAsync({ format: png ? SaveFormat.PNG : SaveFormat.JPEG, compress: 0.85 });
    const base = f.name.replace(/\.[^.]*$/, "") || "image";
    const ext = png ? "png" : "jpg";
    const name = extOf(f.name) === ext || (!png && extOf(f.name) === "jpeg") ? f.name : `${base}.${ext}`;
    const fileSize = await sizeOf(saved.uri);
    return { uri: saved.uri, name, type: png ? "image/png" : "image/jpeg", size: fileSize ?? f.size };
  } catch {
    return f;
  }
}

/** Size of a local file, if it can be read. */
async function sizeOf(uri: string): Promise<number | undefined> {
  try {
    const { File } = await import("expo-file-system");
    const size = new File(uri).size;
    return typeof size === "number" && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

type Asset = ImagePicker.ImagePickerAsset;

async function fromAsset(a: Asset, prepare: boolean): Promise<NativeFile> {
  const type = a.mimeType || TYPES[extOf(a.fileName ?? a.uri)] || (a.type === "video" ? "video/mp4" : "image/jpeg");
  const file: NativeFile = { uri: a.uri, name: a.fileName || nameFor(a.uri, type), type, size: a.fileSize ?? 0 };
  if (!file.size) file.size = (await sizeOf(a.uri)) ?? 0;
  return prepare && a.type !== "video" ? prepareImage(file, IMAGE_EDGE, { width: a.width, height: a.height }) : file;
}

/** Photos and videos from the gallery, up to `max`. Empty when cancelled. */
export async function pickMedia(max: number): Promise<NativeFile[]> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: max > 1,
    selectionLimit: max,
    quality: 1,
  });
  if (res.canceled) return [];
  return Promise.all(res.assets.map((a) => fromAsset(a, true)));
}

/** A photo from the camera. Null when cancelled or not allowed. */
export async function takePhoto(): Promise<NativeFile | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Chat isn't allowed to use the camera. You can allow it in the system settings.");
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
  if (res.canceled || !res.assets[0]) return null;
  return fromAsset(res.assets[0], true);
}

/** Any files. Empty when cancelled. */
export async function pickDocuments(): Promise<NativeFile[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return [];
  return res.assets.map((a) => {
    const type = a.mimeType || TYPES[extOf(a.name)] || "application/octet-stream";
    return { uri: a.uri, name: a.name || nameFor(a.uri, type), type, size: a.size ?? 0 };
  });
}

/** One image for an avatar, square-cropped by the picker and prepared. Null when cancelled. */
export async function pickAvatar(): Promise<NativeFile | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
  const a = res.canceled ? undefined : res.assets[0];
  if (!a) return null;
  const file = await fromAsset(a, false);
  return prepareImage(file, AVATAR_EDGE, { width: a.width, height: a.height });
}

/** As the shared code wants an attachment (LocalFile), with no object URL: a native file shows from its own uri. */
export const toLocal = (f: NativeFile): LocalFile => ({ file: f as unknown as File, url: "" });

/** The native file behind a LocalFile made by toLocal. */
export const nativeOf = (f: LocalFile): NativeFile => f.file as unknown as NativeFile;

/** Shown as a picture (image or video) in the tray and in a sending message. */
export const previewable = (f: NativeFile) => (f.type.startsWith("image/") && f.type !== "image/svg+xml") || isVideo(f.name);
