/// <reference path="../../types/pocketbase.d.ts" />
// Unread counts (DESIGN.md §18): GET /api/chat/unread and POST /api/chat/reads.

const { visibleRoom } = require(`${__hooks}/lib/access.js`);

/**
 * Unread messages per room the caller can see (§23.1): other people's, not deleted, newer than the caller's read position
 * (or their signup, for a room they never opened). One correlated count per room, so each one is a range scan on
 * idx_messages_room_created, stopped at UNREAD_CAP (the badge shows "99+" past 99, so more is never needed).
 * Hidden and archived rooms are counted too; the client doesn't show those (§18.4).
 */
const UNREAD_CAP = 100;
const UNREAD_SQL = `
SELECT room, n FROM (
  SELECT r.id AS room, (
    SELECT COUNT(*) FROM (
      SELECT 1 FROM messages m
      WHERE m.room = r.id
        AND m.created > MAX(COALESCE((SELECT rr.last_read_at FROM room_reads rr WHERE rr.user = {:me} AND rr.room = r.id), ''), {:since})
        AND m.author != {:me}
        AND m.deleted = FALSE
      LIMIT ${UNREAD_CAP}
    )
  ) AS n
  FROM rooms r
  WHERE r.visibility != 'private' OR r.created_by = {:me} OR EXISTS (SELECT 1 FROM json_each(r.members) WHERE value = {:me})
) WHERE n > 0`;

/** @param {core.RequestEvent} e */
function me(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  return e.auth;
}

/** @param {string} message */
const badRequest = (message) =>
  new BadRequestError("Failed to mark the room as read.", { at: new ValidationError("validation_invalid_value", message) });

/**
 * GET /api/chat/unread → { at, rooms: { "<roomId>": count } } for every room with unread messages (at most
 * UNREAD_CAP each). `at` is when the counts were taken: the client adds the live messages created after it, which
 * these counts may not include (§18.3).
 * @param {core.RequestEvent} e
 */
function unread(e) {
  const user = me(e);
  const at = new DateTime().string();
  const rows = arrayOf(new DynamicModel({ room: "", n: 0 }));
  e.app
    .db()
    .newQuery(UNREAD_SQL)
    .bind({ me: user.id, since: user.getString("created") })
    .all(rows);
  /** @type {Record<string, number>} */
  const out = {};
  for (const row of rows) out[row.room] = row.n;
  return e.json(200, { at, rooms: out });
}

/**
 * @param {core.App} app
 * @param {string} user
 * @param {string} room
 */
function findRead(app, user, room) {
  try {
    return app.findFirstRecordByFilter("room_reads", "user = {:user} && room = {:room}", { user, room });
  } catch {
    return null;
  }
}

/**
 * POST /api/chat/reads { room, at? }: the caller has read `room` up to `at` (a message's `created`; default now).
 * Never moves the read position back, and never past now. Idempotent.
 * @param {core.RequestEvent} e
 */
function markRead(e) {
  const user = me(e);
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const roomId = typeof body.room === "string" ? body.room : "";
  // Someone else's DM (or private room) gets the same answer as a room that doesn't exist.
  if (!roomId || !visibleRoom(e.app, roomId, user.id)) throw new NotFoundError("The room doesn't exist.");

  const now = new DateTime();
  let at = now;
  if (body.at !== undefined) {
    // "" too: DateTime("") would be now, which a client sending a message's `created` never means.
    if (typeof body.at !== "string" || body.at === "") throw badRequest("Must be a date.");
    try {
      at = new DateTime(body.at);
    } catch {
      throw badRequest("Must be a date.");
    }
    if (at.isZero()) throw badRequest("Must be a date.");
    if (at.after(now)) at = now;
  }

  let row = findRead(e.app, user.id, roomId);
  if (!row) {
    const created = new Record(e.app.findCollectionByNameOrId("room_reads"));
    created.set("user", user.id);
    created.set("room", roomId);
    created.set("last_read_at", at);
    try {
      e.app.save(created);
      return e.json(200, { room: roomId, last_read_at: created.getString("last_read_at") });
    } catch (err) {
      // Lost a race with another tab: the unique (user, room) index kept it to one row. Update that one.
      row = findRead(e.app, user.id, roomId);
      if (!row) throw err;
    }
  }
  if (at.after(row.getDateTime("last_read_at"))) {
    row.set("last_read_at", at);
    e.app.save(row);
  }
  return e.json(200, { room: roomId, last_read_at: row.getString("last_read_at") });
}

module.exports = { unread, markRead };
