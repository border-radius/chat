// Unsent composer text (§22.3): kept per user and room in localStorage, so it survives visiting other rooms
// (QA BUG-50) and reloading the page. One key per room, so tabs writing in different rooms don't overwrite each other.
// Cleared when the session ends: a shared computer must not show the next person what you were writing.

export interface Drafts {
  get(roomId: string): string;
  /** Blank text removes the draft. */
  set(roomId: string, text: string): void;
  /** Forget every draft of `userId`. */
  clear(userId: string): void;
}

const PREFIX = "chat.draft.";

/** `user`: whose drafts these are now ("" when nobody is logged in: nothing is kept). */
export function createDrafts(user: () => string, storage: Storage | null = safeLocalStorage()): Drafts {
  const key = (roomId: string) => `${PREFIX}${user()}.${roomId}`;
  // Storage can throw (quota, disabled in a private window): drafts are a convenience, never an error.
  const attempt = <T>(fn: (s: Storage) => T, fallback: T): T => {
    try {
      return storage ? fn(storage) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    get: (roomId) => (user() ? attempt((s) => s.getItem(key(roomId)) ?? "", "") : ""),
    set(roomId, text) {
      if (!user()) return;
      attempt((s) => (text.trim() ? s.setItem(key(roomId), text) : s.removeItem(key(roomId))), undefined);
    },
    clear(userId) {
      if (!userId) return;
      attempt((s) => {
        const mine = `${PREFIX}${userId}.`;
        const keys: string[] = [];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k?.startsWith(mine)) keys.push(k);
        }
        for (const k of keys) s.removeItem(k);
      }, undefined);
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
