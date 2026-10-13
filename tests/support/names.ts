// Display names are unique (§22.1), but every test file shares one server and many sign up "Ada" or "Other".
// Before a test account takes a name, an earlier holder is moved aside the way 1760000012_accounts.js keeps the names
// that already clashed: it keeps its name, with its key made unique by its id. Only the key changes, which nothing
// shows, so a test still running with that account (in parallel) sees no difference.

import { runSql } from "./sql.ts";

/** Same as nameKey() in pb_hooks/lib/text.js, after the hook's tidying (plain test names need no more). */
const nameKey = (name: string) => name.replace(/\s+/g, " ").trim().normalize("NFKC").toUpperCase().toLowerCase();

/**
 * Free `name` for a new account on the test server at `url`. Through the server's own write connection (runSql): a
 * write from here would make the server's transactions fail now and then (docs/REFACTOR.md item 30).
 */
export async function releaseName(url: string, name: string): Promise<void> {
  const key = nameKey(name);
  if (!key) return;
  await runSql(url, [{ sql: "UPDATE users SET name_key = name_key || '#' || id WHERE name_key = {:key}", params: { key } }]);
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
export async function withName<T>(url: string, name: string, signUp: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await releaseName(url, name);
    try {
      return await signUp();
    } catch (e) {
      if (attempt >= 30 || !nameTaken(e)) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 50));
    }
  }
}
