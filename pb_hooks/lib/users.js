/// <reference path="../../types/pocketbase.d.ts" />
// GET /api/chat/users?q= (DESIGN.md §16.5): find people to message by name. Matched against `name_key` (case folded
// like names are compared, §22.1), so "иван" finds "Иван" and "strasse" "Straße": SQLite's LIKE only ignores the case
// of ASCII letters (QA BUG-55). `name_key` is hidden from clients, hence a route rather than a filter.

const { nameKey } = require(`${__hooks}/lib/chat.js`);

/** Most people one search returns. */
const LIMIT = 20;

/** @param {core.RequestEvent} e */
function searchUsers(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const raw = e.requestInfo().query.q;
  const key = nameKey(typeof raw === "string" ? raw.trim() : "");
  if (!key) return e.json(200, []);
  // `~` treats a % in the value as a wildcard (and then stops adding its own): escape it (QA BUG-34). `_` is escaped.
  const found = e.app.findRecordsByFilter("users", "name_key ~ {:q} && id != {:me}", "name", LIMIT, 0, {
    q: key.replace(/%/g, "\\%"),
    me: me.id,
  });
  // Only the public profile, never the email (§6).
  return e.json(
    200,
    found.flatMap((u) => (u ? [{ id: u.id, name: u.getString("name"), avatar: u.getString("avatar") }] : [])),
  );
}

module.exports = { searchUsers };
