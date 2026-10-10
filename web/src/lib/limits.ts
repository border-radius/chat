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
} as const;

/** Length as PocketBase counts it for these limits: Unicode code points, not UTF-16 units (an emoji is 1, not 2). */
export function textLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
