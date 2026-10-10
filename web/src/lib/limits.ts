// Field limits the UI enforces before the server does. They mirror pb_migrations (the source of truth);
// tests/integration/schema.test.ts fails if the two drift apart.

export const LIMITS = {
  /** messages.text max */
  messageText: 2000,
  /** users.name max */
  userName: 32,
  /** rooms.name max */
  roomName: 48,
  /** users password min (PocketBase's auth default) */
  passwordMin: 8,
  /** users.avatar maxSize (§15.1) */
  avatarBytes: 2 * 1024 * 1024,
  /** users.avatar mimeTypes (§15.1) */
  avatarTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  /** messages.files maxSelect (§17.1) */
  attachments: 4,
  /** messages.files maxSize, per file (§17.1) */
  attachmentBytes: 8 * 1024 * 1024,
} as const;

/** Length as PocketBase counts it for these limits: Unicode code points, not UTF-16 units (an emoji is 1, not 2). */
export function textLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
