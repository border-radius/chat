/// <reference path="../../types/pocketbase.d.ts" />
// Acting on several messages at once (DESIGN.md §21): POST /api/chat/delete soft-deletes the caller's own messages,
// POST /api/chat/forward copies messages the caller can see into another room or DM. All or nothing: each runs in one
// transaction. The saves go through the messages hooks (chat.js) like any other, so the soft delete wipes what it
// should, a forward is checked like a new message, and realtime tells everyone.

/** Most messages one request may act on (MAX_SELECTED in web/src/lib/limits.ts). */
const MAX_MESSAGES = 50;

/**
 * @param {string} field
 * @param {string} message
 * @param {string} [what]
 */
const badRequest = (field, message, what = "Failed to update the messages.") =>
  new BadRequestError(what, { [field]: new ValidationError("validation_invalid_value", message) });

/**
 * The message ids of the request body: distinct, 1 to MAX_MESSAGES of them.
 * @param {Record<string, unknown>} body
 * @param {string} what
 */
function messageIds(body, what) {
  const raw = body.messages;
  if (!Array.isArray(raw) || !raw.length || raw.some((id) => typeof id !== "string" || !id)) {
    throw badRequest("messages", "Choose at least one message.", what);
  }
  const ids = [.../** @type {Set<string>} */ (new Set(raw))];
  if (ids.length > MAX_MESSAGES) throw badRequest("messages", `At most ${MAX_MESSAGES} messages at a time.`, what);
  return ids;
}

/**
 * Can the caller see `rec` (its collection's view rule)? Someone else's DM gets the same answer as a record that
 * doesn't exist.
 * @param {core.RequestEvent} e
 * @param {core.RequestInfo} info
 * @param {string} collection
 * @param {string} id
 * @returns {core.Record | null}
 */
function visible(e, info, collection, id) {
  let rec;
  try {
    rec = e.app.findRecordById(collection, id);
  } catch {
    return null;
  }
  const rule = e.app.findCollectionByNameOrId(collection).viewRule;
  return rule !== null && rule !== undefined && e.app.canAccessRecord(rec, info, rule) ? rec : null;
}

/**
 * The messages with these ids, oldest first (as they are shown), all visible to the caller; else a 404.
 * @param {core.RequestEvent} e
 * @param {core.RequestInfo} info
 * @param {string[]} ids
 */
function visibleMessages(e, info, ids) {
  const found = ids.map((id) => visible(e, info, "messages", id));
  if (found.some((m) => !m)) throw new NotFoundError("A message doesn't exist.");
  const msgs = /** @type {core.Record[]} */ (found);
  const key = (/** @type {core.Record} */ m) => `${m.getString("created")}|${m.id}`;
  return msgs.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * The saved messages as GET /api/collections/messages/records/:id answers them (the same ?expand and ?fields apply).
 * @param {core.RequestEvent} e
 * @param {core.Record[]} recs
 */
function answer(e, recs) {
  $apis.enrichRecords(e, recs);
  return e.json(200, recs);
}

/**
 * POST /api/chat/delete { messages: [ids] } → the messages, soft-deleted (§21.2). Only the caller's own, in rooms that
 * aren't archived. Already deleted ones are left as they are, so a retry succeeds.
 * @param {core.RequestEvent} e
 */
function deleteMessages(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const what = "Failed to delete the messages.";
  const info = e.requestInfo();
  const msgs = visibleMessages(e, info, messageIds(/** @type {Record<string, unknown>} */ (info.body), what));
  if (msgs.some((m) => m.getString("author") !== me.id)) throw new ForbiddenError("You can only delete your own messages.");
  // (Archived meanwhile: beforeMessageUpdate refuses the save, and the transaction rolls back.)
  if (msgs.some((m) => e.app.findRecordById("rooms", m.getString("room")).getBool("archived"))) {
    throw badRequest("messages", "This room is archived and read-only.", what);
  }

  /** @type {core.Record[]} */
  const saved = [];
  e.app.runInTransaction((tx) => {
    for (const m of msgs) {
      const rec = tx.findRecordById("messages", m.id);
      saved.push(rec);
      if (rec.getBool("deleted")) continue;
      rec.set("deleted", true);
      tx.save(rec);
    }
  });
  return answer(e, saved);
}

/**
 * POST /api/chat/forward { messages: [ids], room } → the new messages in `room` (§21.3): copies of the given ones,
 * oldest first, by the caller, each saying who first wrote it (`forwarded_from`, kept through forwards of forwards).
 * Text and attachments are copied; replies, reactions and edit stamps are not.
 * @param {core.RequestEvent} e
 */
function forward(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const what = "Failed to forward the messages.";
  const info = e.requestInfo();
  const body = /** @type {Record<string, unknown>} */ (info.body);
  const ids = messageIds(body, what);
  const room = visible(e, info, "rooms", typeof body.room === "string" ? body.room : "");
  if (!room) throw new NotFoundError("The room doesn't exist.");
  if (room.getBool("archived")) throw badRequest("room", "This room is archived and read-only.", what);
  const msgs = visibleMessages(e, info, ids);
  if (msgs.some((m) => m.getBool("deleted"))) throw badRequest("messages", "A message was deleted.", what);

  const collection = e.app.findCollectionByNameOrId("messages");
  const fsys = e.app.newFilesystem();
  /** @type {core.Record[]} */
  const saved = [];
  try {
    e.app.runInTransaction((tx) => {
      // One millisecond apart, so they keep their order: messages sort by (created, id), and ids are random.
      const now = Date.now();
      msgs.forEach((src, i) => {
        const rec = new Record(collection);
        const at = new Date(now + i).toISOString().replace("T", " ");
        rec.setRaw("created", at);
        rec.setRaw("updated", at);
        rec.set("room", room.id);
        rec.set("author", me.id);
        rec.set("text", src.getString("text"));
        rec.set("forwarded_from", src.getString("forwarded_from") || src.getString("author"));
        /** @type {Record<string, string>} */
        const names = JSON.parse(src.getString("file_names") || "{}") || {};
        const files = src.getStringSlice("files").map((name) => {
          const f = fsys.getReuploadableFile(`${src.baseFilesPath()}/${name}`, false);
          f.originalName = names[name] || name; // kept as the copy's file_names by beforeMessageCreate
          return f;
        });
        if (files.length) rec.set("files", files);
        tx.save(rec);
        saved.push(rec);
      });
    });
  } finally {
    fsys.close();
  }
  return answer(e, saved);
}

module.exports = { deleteMessages, forward, MAX_MESSAGES };
