// Display names are unique (§22.1), but every test file shares one server and many sign up "Ada" or "Other".
// Before a test account takes a name, an earlier holder is moved aside the way 1760000012_accounts.js keeps the names
// that already clashed: it keeps its name, with its key made unique by its id. Only the key changes, which nothing
// shows, so a test still running with that account (in parallel) sees no difference.

import type { DatabaseSync } from "node:sqlite";

/** Same as nameKey() in pb_hooks/lib/chat.js, after the hook's tidying (plain test names need no more). */
const nameKey = (name: string) => name.replace(/\s+/g, " ").trim().normalize("NFKC").toUpperCase().toLowerCase();

/** Is `name` held by an account? */
function taken(db: DatabaseSync, key: string): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE name_key = ?").get(key);
}

/** Free `name` for a new account. `db` is the test server's data.db, opened writable. */
export function releaseName(db: DatabaseSync, name: string): void {
  const key = nameKey(name);
  if (!key) return;
  db.exec("PRAGMA busy_timeout = 5000");
  // Read first: most names are free, and a write would hold the database lock that the server and parallel tests need.
  if (!taken(db, key)) return;
  db.prepare("UPDATE users SET name_key = name_key || '#' || id WHERE name_key = ?").run(key);
}

/**
 * Was a sign up refused for its name? The hook says so on `name` (validation_not_unique), as an ApiError or an SDK
 * error; two sign ups racing past the hook hit the unique index instead.
 */
const nameTaken = (e: unknown) => /validation_not_unique|UNIQUE constraint failed: users\.name_key/.test(`${JSON.stringify(e)} ${e}`);

/**
 * Run `signUp` for `name`, freeing the name first. Parallel test files often sign up the same name at the same moment
 * (every room test is "Me"), so a sign up refused for its name is retried after a random pause.
 */
export async function withName<T>(open: () => DatabaseSync, name: string, signUp: () => Promise<T>): Promise<T> {
  const withDb = <R>(fn: (db: DatabaseSync) => R): R => {
    const db = open();
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      return fn(db);
    } finally {
      db.close();
    }
  };
  for (let attempt = 0; ; attempt++) {
    withDb((db) => releaseName(db, name));
    try {
      return await signUp();
    } catch (e) {
      if (attempt >= 30 || !nameTaken(e)) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 50));
    }
  }
}
