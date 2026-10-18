/// <reference path="../../types/pocketbase.d.ts" />
// messages hooks (DESIGN.md §5.6, §17, §19, §20, §21, §28): text, attachments, replies, forwards, soft delete, edit stamps.
// A forward (§21.3) has no text or files of its own: it shows those of the message in `forward_of` (showOriginal).

const { assertImagesFit } = require(`${__hooks}/lib/images.js`);
const { accessOf, canSee, canWrite, visibleRoom } = require(`${__hooks}/lib/access.js`);
const { fieldError, originalNames, recordOf } = require(`${__hooks}/lib/records.js`);
const { dmRefusal } = require(`${__hooks}/lib/dms.js`);
const { isDm } = require(`${__hooks}/lib/rooms.js`);
const { cleanText, isBlank } = require(`${__hooks}/lib/text.js`);

/**
 * Trim a text field in place (required/min validation then rejects blanks).
 * @param {core.Record} record
 * @param {string} field
 */
function trim(record, field) {
  record.set(field, record.getString(field).trim());
}

/**
 * The message's room, which must be active (not archived). Null when no room is set.
 * @param {core.App} app
 * @param {string} roomId
 */
function activeRoom(app, roomId) {
  if (!roomId) return null; // the relation's own `required` validation reports this
  const room = app.findRecordById("rooms", roomId);
  if (room.getBool("archived")) throw fieldError("room", "This room is archived and read-only.");
  return room;
}

/**
 * Clean (no control characters, QA BUG-105), trimmed text that isn't blank, unless `blankOk` (a message with
 * attachments may have no text, §17.1).
 * @param {core.Record} record
 * @param {boolean} [blankOk]
 */
function assertText(record, blankOk = false) {
  record.set("text", cleanText(record.getString("text")));
  trim(record, "text");
  const text = record.getString("text");
  if (!isBlank(text)) return;
  if (!blankOk) throw fieldError("text", "Cannot be blank.");
  record.set("text", ""); // e.g. only zero-width characters next to an attachment
}

/**
 * Attachment names: those already stored plus those uploaded with this request.
 * @param {core.Record} record
 */
const fileNames = (record) => [...record.getStringSlice("files"), ...record.getUnsavedFiles("files").map((f) => (f ? f.name : ""))];

/**
 * Is this message a forward (§21.3)? A forward's text may be blank: it shows the original's, or nothing once that is gone.
 * @param {core.Record} rec
 */
const isForward = (rec) => rec.getString("forwarded_from") !== "";

/**
 * Is this a service message (§5.3): the app's own notice in a room, with no author?
 * @param {core.Record} rec
 */
const isService = (rec) => rec.getString("author") === "";

/**
 * Post a service message (§5.3) in a room that isn't archived: one line of the app's own, no author. It goes through
 * the same hooks as any message, so unread counts and realtime see it.
 * @param {core.App} app
 * @param {string} roomId
 * @param {string} text
 */
function postService(app, roomId, text) {
  const rec = new Record(app.findCollectionByNameOrId("messages"));
  rec.set("room", roomId);
  rec.set("text", text);
  app.save(rec);
}

/**
 * messages create: trim + non-empty text, room must be active (§5.6).
 * @param {core.RecordEvent} e
 */
function beforeMessageCreate(e) {
  const rec = recordOf(e);
  if (isService(rec)) {
    // Made only by postService (no request can leave out the author): text alone, in any room that isn't archived.
    assertText(rec);
    rec.set("reactions", []);
    rec.set("previews", []);
    activeRoom(e.app, rec.getString("room"));
    return;
  }
  assertText(rec, fileNames(rec).length > 0 || isForward(rec));
  assertImagesFit(rec, "files");
  rec.set("file_names", originalNames(rec, "files")); // whatever the client sent is replaced
  rec.set("reactions", []); // only POST /api/chat/reactions adds them (§20.2)
  rec.set("previews", []); // only the previews worker sets them (§28)
  const room = activeRoom(e.app, rec.getString("room"));
  // Defense in depth for the members-only create rule (§16.3, §23.1): DMs and private rooms.
  if (room && !canSee(accessOf(room), rec.getString("author"))) {
    throw fieldError("room", isDm(room) ? "You are not a member of this conversation." : "You are not a member of this room.");
  }
  // ... and for who may post in it (§23.6): forwards and the Telegram bridge come through here too.
  if (room && !canWrite(room, rec.getString("author"))) throw fieldError("room", "Only some people can post in this room.");
  if (room && isDm(room)) {
    const refused = dmRefusal(e.app, rec.getString("author"), room.getStringSlice("members"));
    if (refused) throw fieldError("room", refused);
  }
  assertReplyTarget(e.app, rec);
  assertForwardTarget(e.app, rec);
}

/**
 * A forward (§21.3) shows an original that is still there: not deleted, and not a forward itself (POST
 * /api/chat/forward points a forward of a forward at its original), so a chain is never more than one step.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function assertForwardTarget(app, rec) {
  const id = rec.getString("forward_of");
  if (!id) return;
  let original = null;
  try {
    original = app.findRecordById("messages", id);
  } catch {
    original = null;
  }
  if (!original || original.getBool("deleted")) throw fieldError("forward_of", "That message was deleted.");
  if (original.getString("forward_of") !== "") throw fieldError("forward_of", "That message is a forward.");
}

/**
 * A reply (§19) answers a message of the same room that is still there. Without this check a reply could
 * point into a DM you're not in, and its expanded preview would show you that message.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function assertReplyTarget(app, rec) {
  const id = rec.getString("reply_to");
  if (!id) return;
  let parent = null;
  try {
    parent = app.findRecordById("messages", id);
  } catch {
    parent = null;
  }
  if (!parent || parent.getString("room") !== rec.getString("room")) {
    throw fieldError("reply_to", "That message isn't in this room.");
  }
  if (parent.getBool("deleted")) throw fieldError("reply_to", "That message was deleted.");
  if (isService(parent)) throw fieldError("reply_to", "Service messages can't be replied to.");
}

/**
 * Is this update PocketBase clearing `reply_to` because the message it pointed at no longer exists? Users can't
 * remove messages (only soft-delete them), and the update rule refuses any `reply_to` in a request body.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record} orig
 */
function replyTargetRemoved(app, rec, orig) {
  const id = orig.getString("reply_to");
  if (!id || rec.getString("reply_to") !== "") return false;
  try {
    app.findRecordById("messages", id);
    return false;
  } catch {
    return true;
  }
}

/**
 * Is this update PocketBase clearing `forward_of` because the original was deleted for good (by a superuser, or with
 * its room)? The forward then shows nothing (§21.3). The update rule refuses any `forward_of` in a request body.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record} orig
 */
function originalRemoved(app, rec, orig) {
  const id = orig.getString("forward_of");
  if (!id || rec.getString("forward_of") !== "") return false;
  try {
    app.findRecordById("messages", id);
    return false;
  } catch {
    return true;
  }
}

/**
 * Is this update PocketBase clearing `forwarded_from` because the user it named was deleted (by a superuser)? The
 * update rule refuses any `forwarded_from` in a request body.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record} orig
 */
function forwardSourceRemoved(app, rec, orig) {
  const id = orig.getString("forwarded_from");
  if (!id || rec.getString("forwarded_from") !== "") return false;
  try {
    app.findRecordById("users", id);
    return false;
  } catch {
    return true;
  }
}

/**
 * messages create through the API: only POST /api/chat/forward, whose own saves don't come through here, makes a
 * forward (§21.3). Backs up the create rule against field modifiers.
 * @param {core.RecordRequestEvent} e
 */
function beforeMessageCreateRequest(e) {
  const rec = recordOf(e);
  for (const f of ["forwarded_from", "forward_of"]) if (rec.getString(f) !== "") throw fieldError(f, "This field can't be set.");
}

/**
 * messages, after a create is committed: a DM records its latest activity (sorts the DM list) and reopens
 * itself for members who had closed it (§16.4).
 * @param {core.RecordEvent} e
 */
function afterMessageCreate(e) {
  const rec = recordOf(e);
  const room = e.app.findRecordById("rooms", rec.getString("room"));
  if (!isDm(room)) return;
  room.set("last_message_at", rec.get("created"));
  e.app.save(room);
  const author = rec.getString("author");
  for (const member of room.getStringSlice("members")) {
    if (member === author) continue;
    const rows = e.app.findRecordsByFilter("hidden_rooms", "user = {:user} && room = {:room}", "", 1, 0, { user: member, room: room.id });
    for (const row of rows) if (row) e.app.delete(row);
  }
}

/**
 * messages update: soft delete, edit stamp, archived guard (§5.6).
 * @param {core.RecordEvent} e
 */
function beforeMessageUpdate(e) {
  const rec = recordOf(e);
  const orig = rec.original();
  // A message deleted for good (by a superuser, or with its room) is already gone when PocketBase unsets the
  // reply_to of its replies (§19.1). Let that save through: the guards below would refuse it, and with it the delete.
  if (replyTargetRemoved(e.app, rec, orig) || forwardSourceRemoved(e.app, rec, orig) || originalRemoved(e.app, rec, orig)) return;
  activeRoom(e.app, orig.getString("room"));

  if (orig.getBool("deleted")) {
    // Deletion is final; API rules already refuse this, so this only guards superuser edits.
    throw fieldError("deleted", "Deleted messages cannot be changed.");
  }
  // Backs up the update rule, which field modifiers could get around (§19).
  if (rec.getString("reply_to") !== orig.getString("reply_to")) throw fieldError("reply_to", "This field can't be changed.");
  for (const f of ["forwarded_from", "forward_of"]) {
    if (rec.getString(f) !== orig.getString(f)) throw fieldError(f, "This field can't be changed.");
  }

  if (rec.getBool("deleted")) {
    rec.set("text", "");
    rec.set("files", []); // PocketBase deletes the stored files once the update commits (§17.1)
    rec.set("file_names", {});
    rec.set("reactions", []);
    rec.set("previews", []);
    rec.set("deleted_at", new DateTime());
    rec.set("edited_at", orig.get("edited_at"));
    return;
  }

  rec.set("file_names", orig.get("file_names")); // never changed by an edit
  // Reactions only change through POST /api/chat/reactions (§20.2). Any other save (an edit) keeps the ones stored
  // now, not the ones loaded with the record: a reaction added meanwhile would be lost. (Edits save in a transaction.)
  if (rec.getString("reactions") === orig.getString("reactions")) {
    rec.set("reactions", e.app.findRecordById("messages", rec.id).get("reactions"));
  }
  // Attachments are immutable after sending (backs up the update rule, which field modifiers could get around).
  const files = fileNames(rec);
  if (files.join("/") !== orig.getStringSlice("files").join("/")) throw fieldError("files", "Attachments can't be changed.");
  assertText(rec, files.length > 0 || isForward(rec));
  if (rec.getString("text") !== orig.getString("text")) {
    rec.set("previews", []); // the worker looks at the new text's links (§28)
  } else if (rec.getString("previews") === orig.getString("previews")) {
    // As for reactions: the ones stored now, not those loaded with the record (the worker may have saved meanwhile).
    rec.set("previews", e.app.findRecordById("messages", rec.id).get("previews"));
  }
  if (rec.getString("text") !== orig.getString("text")) {
    // A forward's words are someone else's: "Forwarded from Bob" must stay true (§21.3). It can still be deleted.
    if (orig.getString("forwarded_from") !== "") throw fieldError("text", "Forwarded messages can't be edited.");
    rec.set("edited_at", new DateTime());
  }
}

/**
 * messages update through the API: reactions only change through POST /api/chat/reactions, whose own saves don't
 * come through here (§20.2). Backs up the update rule.
 * @param {core.RecordRequestEvent} e
 */
function beforeMessageUpdateRequest(e) {
  const rec = recordOf(e);
  for (const f of ["reactions", "previews"]) {
    if (rec.getString(f) !== rec.original().getString(f)) throw fieldError(f, "This field can't be changed.");
  }
}

/**
 * Will this update change what forwards of the message show (§21.3)? Called with the update about to be saved.
 * @param {core.Record} rec
 */
function changesForwards(rec) {
  const orig = rec.original();
  return (
    rec.getString("text") !== orig.getString("text") ||
    rec.getBool("deleted") !== orig.getBool("deleted") ||
    rec.getString("previews") !== orig.getString("previews")
  );
}

/**
 * After an edit or delete of a message: its forwards are saved again (nothing in them changes), so everyone who sees
 * one hears of it live, with the original as it is now (showOriginal). They can't hear of the original itself: it is
 * in a room they may not see. Forwards in archived rooms are left alone: they can't be saved, and show it once loaded.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function touchForwards(app, rec) {
  const forwards = app.findRecordsByFilter("messages", "forward_of = {:id} && deleted = false", "", 0, 0, { id: rec.id });
  for (const fwd of forwards) {
    if (!fwd || app.findRecordById("rooms", fwd.getString("room")).getBool("archived")) continue;
    app.save(fwd);
  }
}

/**
 * Every message the API answers with or sends live (lists, reads, expanded replies, realtime): a forward that isn't
 * deleted shows its original's text, attachments and edit stamp (§21.3), or nothing once that is deleted. Whoever
 * sees the forward may see those: the view rule grants it, as for the attachments' URLs (the original's).
 * Only in the answer: nothing is saved.
 * @param {core.RecordEnrichEvent} e
 */
function showOriginal(e) {
  const rec = e.record;
  const id = rec ? rec.getString("forward_of") : "";
  if (!rec || !id || rec.getBool("deleted")) return;
  let original = null;
  try {
    original = e.app.findRecordById("messages", id);
  } catch {
    return; // being removed for good: PocketBase is about to clear forward_of
  }
  const gone = original.getBool("deleted");
  rec.set("text", gone ? "" : original.getString("text"));
  rec.set("files", gone ? [] : original.getStringSlice("files"));
  rec.set("file_names", gone ? {} : original.get("file_names"));
  rec.set("previews", gone ? [] : original.get("previews"));
  rec.set("edited_at", gone ? "" : original.get("edited_at"));
}

/**
 * A message read only through a forward of it (the view rule grants that, §21.3) keeps to itself what would say who
 * is in its room: its reactions (who reacted) and the message it replies to. Only in the answer: nothing is saved.
 * Most messages have neither, and cost nothing here.
 * @param {core.RecordEnrichEvent} e
 */
function keepToRoom(e) {
  const rec = e.record;
  const info = e.requestInfo;
  if (!rec || !info || info.auth?.isSuperuser()) return;
  const reactions = rec.getString("reactions");
  if (!rec.getString("reply_to") && (reactions === "" || reactions === "[]" || reactions === "null")) return;
  if (visibleRoom(e.app, rec.getString("room"), info.auth?.id ?? "")) return;
  rec.set("reactions", []);
  rec.set("reply_to", "");
}

/**
 * users delete (a superuser): refused while they have messages. `author` isn't required (service messages have none,
 * §5.3), so PocketBase would otherwise clear it on their messages, which would then read as the app's own notices.
 * @param {core.RecordEvent} e
 */
function beforeUserDelete(e) {
  const id = recordOf(e).id;
  if (e.app.findRecordsByFilter("messages", "author = {:id}", "", 1, 0, { id }).length) {
    throw new BadRequestError("This user wrote messages, so their account can't be deleted.");
  }
}

module.exports = {
  isService,
  beforeUserDelete,
  postService,
  beforeMessageCreate,
  beforeMessageCreateRequest,
  afterMessageCreate,
  beforeMessageUpdate,
  beforeMessageUpdateRequest,
  changesForwards,
  touchForwards,
  showOriginal,
  keepToRoom,
};
