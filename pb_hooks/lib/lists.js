/// <reference path="../../types/pocketbase.d.ts" />
// The room list and a room's message pages, as routes (docs/API.md): the clients say which page they want and the
// server writes the filter, so the schema can change under them. Both answer as the records API does (the same
// ?expand and ?fields, applied to each record; the enrich hooks), as a plain array, and see what the API rules let
// the caller see (lib/access.js). Apps from before these routes still list `rooms` and `messages` through the records
// API, which stays as it was.

const { SEES_SQL, visibleRoom } = require(`${__hooks}/lib/access.js`);

/** Messages in a page unless `limit` says otherwise (web/src/lib/cursor.ts PAGE_SIZE). */
const PAGE_SIZE = 50;
const MAX_LIMIT = 200;

/**
 * A room's pages (DESIGN.md §7.5), keyset by (created, id), and the edits and deletes missed while offline (`changed`).
 * `latest` and `older` come newest first, the others oldest first.
 * @type {Record<string, { where: string, params: string[], sort: string }>}
 */
const KINDS = {
  latest: { where: "", params: [], sort: "-created,-id" },
  first: { where: "", params: [], sort: "created,id" },
  older: { where: "(created < {:created} || (created = {:created} && id < {:id}))", params: ["created", "id"], sort: "-created,-id" },
  newer: { where: "(created > {:created} || (created = {:created} && id > {:id}))", params: ["created", "id"], sort: "created,id" },
  changed: { where: "updated > {:since} && created >= {:from} && created <= {:to}", params: ["since", "from", "to"], sort: "updated,id" },
};

/**
 * GET /api/chat/rooms → the rooms: every room the caller can see, by name. Guests: the Open Air rooms (§23.3).
 * @param {core.RequestEvent} e
 */
function rooms(e) {
  const me = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  const where = e.hasSuperuserAuth() ? "1" : me ? SEES_SQL : "r.visibility = 'open' AND NOT r.archived";
  const rows = arrayOf(new DynamicModel({ id: "" }));
  e.app.db().newQuery(`SELECT r.id FROM rooms r WHERE ${where} ORDER BY r.name, r.id`).bind({ me }).all(rows);
  const found = e.app.findRecordsByIds(
    "rooms",
    rows.map((r) => r.id),
  );
  const byId = new Map(found.map((r) => [r?.id, r]));
  const items = /** @type {core.Record[]} */ (rows.map((r) => byId.get(r.id)).filter(Boolean));
  $apis.enrichRecords(e, items);
  return e.json(200, items);
}

/**
 * GET /api/chat/rooms/{room}/messages?kind=latest|first|older|newer|changed → the messages. `older` and `newer` take the
 * cursor (`created`, `id`); `changed` takes `since` (an `updated` value) and `from`, `to` (`created` values). `files=1`:
 * only messages that may have attachments (theirs, or a forward's original's, §17.7). `limit` (at most 200) and `page`
 * (from 1) as the records API has them. A room the caller can't see has no messages, as the records API says.
 * @param {core.RequestEvent} e
 */
function messages(e) {
  const roomId = e.request?.pathValue("room") ?? "";
  const q = e.requestInfo().query;
  const kind = KINDS[q.kind || "latest"];
  if (!kind) throw new BadRequestError("Unknown page kind.");
  const me = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (!e.hasSuperuserAuth() && !visibleRoom(e.app, roomId, me)) return e.json(200, []);
  /** @type {Record<string, string>} */
  const params = { room: roomId };
  for (const p of kind.params) {
    // An empty id is a cursor too: `newer` than (created, "") starts at `created` itself (around a message, §7.5).
    if (typeof q[p] !== "string" || (p !== "id" && !q[p])) throw new BadRequestError(`Missing ${p}.`);
    params[p] = q[p];
  }
  const where = ["room = {:room}", kind.where, q.files === "1" ? `(files:length > 0 || forward_of != "")` : ""].filter(Boolean);
  const limit = Math.min(Math.max(Number.parseInt(q.limit, 10) || PAGE_SIZE, 1), MAX_LIMIT);
  const page = Math.max(Number.parseInt(q.page, 10) || 1, 1);
  const items = e.app.findRecordsByFilter("messages", where.join(" && "), kind.sort, limit, (page - 1) * limit, params);
  $apis.enrichRecords(e, items);
  return e.json(200, items);
}

module.exports = { rooms, messages };
