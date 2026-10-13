// Avatar fallback (§15.4): initials and a color picked from the user id. Pure, so the id → color mapping and
// grapheme handling are unit-tested.

/** Number of avatar palette colors (`.avatar.c0` … `.c7` in styles/app/avatars.css). */
export const AVATAR_COLORS = 8;

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** First grapheme of `word` (so emoji and combining marks stay whole). */
function firstGrapheme(word: string): string {
  if (segmenter) {
    for (const { segment } of segmenter.segment(word)) return segment;
    return "";
  }
  return [...word][0] ?? "";
}

/** Up to two initials: the first letters of the first two words, upper-cased. "?" for a blank name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const out = words.map((w) => firstGrapheme(w).toLocaleUpperCase()).join("");
  return out || "?";
}

/** Palette index for a user id (FNV-1a), stable across renames. */
export function avatarColor(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % AVATAR_COLORS;
}
