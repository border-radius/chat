/// <reference path="../../types/pocketbase.d.ts" />
// Shared logic for main.pb.js. PocketBase hook handlers can't see top-level variables,
// so each handler require()s this module.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Invisible format characters: zero-width spaces and joiners, bidi marks/overrides/isolates, word joiners,
 * BOM, soft hyphen. `String.trim()` keeps them, so text made only of these would look empty.
 */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Removed from names (users, rooms): never needed there, and used to spoof ("‮admin", "general​").
 * ZWNJ/ZWJ (U+200C/D) stay: some scripts and emoji sequences need them.
 */
const NAME_JUNK = /[­᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Control characters (tabs, line breaks, C1) and line/paragraph separators: shown as spaces, if at all (QA BUG-38). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Longest original file name kept, in UTF-8 bytes. PocketBase stores the original name as file metadata cut at
 * 255 bytes, which can split a character and then fails the whole upload (QA BUG-35).
 */
const MAX_FILE_NAME_BYTES = 200;

const { assertImagesFit } = require(`${__hooks}/lib/images.js`);

/** @param {string} s */
const isBlank = (s) => s.replace(INVISIBLE, "").trim() === "";

/**
 * A name as it should be shown: no invisible/bidi characters, control characters as spaces, every run of
 * whitespace as one space, trimmed. Names that look the same are then the same (QA BUG-38).
 * @param {string} s
 */
const tidy = (s) => s.replace(NAME_JUNK, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();

/** @param {string} s */
const utf8Length = (s) => {
  let n = 0;
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
};

/**
 * `name` cut to at most `max` UTF-8 bytes on a character boundary, keeping its extension (QA BUG-36).
 * @param {string} name
 * @param {number} [max]
 */
function clipFileName(name, max = MAX_FILE_NAME_BYTES) {
  if (utf8Length(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  let stem = "";
  let n = utf8Length(ext);
  for (const c of name.slice(0, name.length - ext.length)) {
    n += utf8Length(c);
    if (n > max) break;
    stem += c;
  }
  return stem.trimEnd() + ext;
}

/**
 * @param {string} field
 * @param {string} message
 * @param {string} [code]
 */
function fieldError(field, message, code = "validation_invalid_value") {
  return new BadRequestError("Failed to save record.", {
    [field]: new ValidationError(code, message),
  });
}

/**
 * Trim a text field in place (required/min validation then rejects blanks).
 * @param {core.Record} record
 * @param {string} field
 */
function trim(record, field) {
  record.set(field, record.getString(field).trim());
}

/**
 * Clean a display name or room name in place: drop invisible/bidi characters, trim, reject if nothing visible.
 * @param {core.Record} record
 */
function cleanName(record) {
  const name = tidy(record.getString("name"));
  record.set("name", name);
  // Empty is left to the field's `required` rule (same message as before); only-invisible is caught here.
  if (name !== "" && isBlank(name)) throw fieldError("name", "Cannot be blank.");
}

/**
 * Uniqueness key for room names: NFKC + full case folding (via upper→lower, so "ß" matches "SS" and "Ü" "ü"),
 * without invisible characters. Keep in sync with pb_migrations/1760000001_qa_fixes.js.
 * @param {string} name
 */
function roomKey(name) {
  const s = name.replace(INVISIBLE, "");
  return (typeof s.normalize === "function" ? s.normalize("NFKC") : s).toUpperCase().toLowerCase();
}

/**
 * Leading "#"s of a room name: rooms are shown as "#name", so "#general" would read "##general", next to a
 * different "general" (QA BUG-48).
 * @param {string} name
 */
const stripHashes = (name) => name.replace(/^[#\s]+/, "");

/**
 * rooms create/update: clean the name and enforce case-insensitive (Unicode) uniqueness via `name_key`.
 * The unique index on name_key backs this up against races.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function setRoomKey(app, rec) {
  cleanName(rec);
  rec.set("name", stripHashes(rec.getString("name")));
  const key = roomKey(rec.getString("name"));
  rec.set("name_key", key);
  if (key === "") return; // `required` on name reports it
  let clash = null;
  try {
    clash = app.findFirstRecordByFilter("rooms", "name_key = {:key} && id != {:id}", { key, id: rec.id });
  } catch {
    clash = null; // no such record
  }
  if (clash) throw fieldError("name", "Value must be unique.", "validation_not_unique");
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

/** @param {core.Record} room */
const isDm = (room) => room.getString("kind") === "dm";

/**
 * Trimmed text that isn't blank, unless `blankOk` (a message with attachments may have no text, §17.1).
 * @param {core.Record} record
 * @param {boolean} [blankOk]
 */
function assertText(record, blankOk = false) {
  trim(record, "text");
  const text = record.getString("text");
  if (!isBlank(text)) return;
  if (!blankOk) throw fieldError("text", "Cannot be blank.");
  record.set("text", ""); // e.g. only zero-width characters next to an attachment
}

/**
 * Original names of this request's uploads in `field`, keyed by stored name (QA BUG-28). Cleaned like display
 * names, so bidi overrides can't disguise a file ("invoice‮fdp.exe"), and capped in length with the extension
 * kept. The upload itself gets the same name, so PocketBase never has to cut it (QA BUG-35).
 * @param {core.Record} record
 * @param {string} field
 */
function originalNames(record, field) {
  /** @type {Record<string, string>} */
  const names = {};
  for (const f of record.getUnsavedFiles(field)) {
    if (!f) continue;
    const original = clipFileName(tidy(f.originalName));
    f.originalName = original || f.name;
    if (original) names[f.name] = original;
  }
  return names;
}

/**
 * Attachment names: those already stored plus those uploaded with this request.
 * @param {core.Record} record
 */
const fileNames = (record) => [...record.getStringSlice("files"), ...record.getUnsavedFiles("files").map((f) => (f ? f.name : ""))];

/**
 * The event's record. PocketBase always sets it in record hooks; the generated types mark it optional (a Go pointer).
 * @param {{ record?: core.Record | undefined }} e
 */
function recordOf(e) {
  if (!e.record) throw new Error("record hook called without a record");
  return e.record;
}

/**
 * messages create: trim + non-empty text, room must be active (§5.6).
 * @param {core.RecordEvent} e
 */
function beforeMessageCreate(e) {
  const rec = recordOf(e);
  assertText(rec, fileNames(rec).length > 0);
  assertImagesFit(rec, "files");
  rec.set("file_names", originalNames(rec, "files")); // whatever the client sent is replaced
  rec.set("reactions", []); // only POST /api/chat/reactions adds them (§20.2)
  const room = activeRoom(e.app, rec.getString("room"));
  // Defense in depth for the members-only create rule (§16.3).
  if (room && isDm(room) && !room.getStringSlice("members").includes(rec.getString("author"))) {
    throw fieldError("room", "You are not a member of this conversation.");
  }
  assertReplyTarget(e.app, rec);
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
  if (replyTargetRemoved(e.app, rec, orig)) return;
  activeRoom(e.app, orig.getString("room"));

  if (orig.getBool("deleted")) {
    // Deletion is final; API rules already refuse this, so this only guards superuser edits.
    throw fieldError("deleted", "Deleted messages cannot be changed.");
  }
  // Backs up the update rule, which field modifiers could get around (§19).
  if (rec.getString("reply_to") !== orig.getString("reply_to")) throw fieldError("reply_to", "This field can't be changed.");

  if (rec.getBool("deleted")) {
    rec.set("text", "");
    rec.set("files", []); // PocketBase deletes the stored files once the update commits (§17.1)
    rec.set("file_names", {});
    rec.set("reactions", []);
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
  assertText(rec, files.length > 0);
  if (rec.getString("text") !== orig.getString("text")) {
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
  if (rec.getString("reactions") !== rec.original().getString("reactions")) throw fieldError("reactions", "This field can't be changed.");
}

/**
 * A public room needs a (unique) name; a DM has none (its title is the other member's name, §16.1).
 * @param {core.App} app
 * @param {core.Record} rec
 */
function setRoomName(app, rec) {
  if (isDm(rec)) {
    rec.set("name", "");
    rec.set("name_key", "");
    return;
  }
  setRoomKey(app, rec);
  if (rec.getString("name") === "") throw fieldError("name", "Cannot be blank.", "validation_required");
}

/**
 * rooms create: public unless said otherwise; clean the name and check it is unique (§5.2, §16.1).
 * @param {core.RecordEvent} e
 */
function beforeRoomCreate(e) {
  const rec = recordOf(e);
  if (!rec.getString("kind")) rec.set("kind", "public");
  setRoomName(e.app, rec);
}

/** Fields only the DM route and hooks may set (§16.3). */
const DM_FIELDS = ["kind", "members", "dm_key", "last_message_at"];

/**
 * A DM field's value, comparable with ===.
 * @param {core.Record} rec
 * @param {string} field
 */
const dmValue = (rec, field) => (field === "members" ? rec.getStringSlice(field).join(",") : rec.getString(field));

/**
 * rooms create through the API: only public rooms (DMs come from POST /api/chat/dms). Backs up the create rule,
 * including against field modifiers such as `members+`.
 * @param {core.RecordRequestEvent} e
 */
function beforeRoomCreateRequest(e) {
  const rec = recordOf(e);
  const kind = rec.getString("kind");
  if (kind && kind !== "public") throw fieldError("kind", "Rooms created here are public.");
  for (const f of DM_FIELDS.slice(1)) {
    if (dmValue(rec, f) !== "") throw fieldError(f, "This field can't be set.");
  }
}

/**
 * rooms update through the API: the DM fields never change (backs up the update rule, §16.3).
 * @param {core.RecordRequestEvent} e
 */
function beforeRoomUpdateRequest(e) {
  const rec = recordOf(e);
  const orig = rec.original();
  for (const f of DM_FIELDS) {
    if (dmValue(rec, f) !== dmValue(orig, f)) throw fieldError(f, "This field can't be changed.");
  }
}

/**
 * users create/update: clean the display name (§5.1). A new email is stored in lower case, so the same address can't
 * make two accounts and logging in doesn't depend on how it was capitalized (QA BUG-47). Existing ones are left as they
 * are on other updates (the migration lowered every one it could).
 * @param {core.RecordEvent} e
 */
function beforeUserSave(e) {
  const rec = recordOf(e);
  const email = rec.getString("email");
  if (rec.isNew() || email !== rec.original().getString("email")) rec.set("email", email.trim().toLowerCase());
  cleanName(rec);
  assertImagesFit(rec, "avatar");
  originalNames(rec, "avatar"); // only for the upload's own name (QA BUG-35)
}

/**
 * rooms update: clean + unique name, stamp/clear archived_at when `archived` flips (§5.6).
 * @param {core.RecordEvent} e
 */
function beforeRoomUpdate(e) {
  const rec = recordOf(e);
  const orig = rec.original();
  if (!isDm(rec) && rec.getString("name") === orig.getString("name")) {
    // Name unchanged: keep its key and don't check it again. Rooms named before name_key existed may share a key
    // (the migration made those unique), and must still be archivable (QA BUG-41).
    rec.set("name_key", orig.getString("name_key"));
  } else {
    setRoomName(e.app, rec);
  }
  if (isDm(rec)) return;
  const was = orig.getBool("archived");
  const now = rec.getBool("archived");
  if (!was && now) rec.set("archived_at", new DateTime());
  if (was && !now) rec.set("archived_at", "");
}

/**
 * users auth-with-password: an email that matched nobody as typed is looked up in lower case, the way emails are
 * stored (QA BUG-47). PocketBase then checks the password as usual.
 * @param {core.RecordAuthWithPasswordRequestEvent} e
 */
function findLoginByEmail(e) {
  if (e.record || (e.identityField && e.identityField !== "email") || !e.identity.includes("@")) return;
  try {
    e.record = e.app.findFirstRecordByFilter("users", "email = {:email}", { email: e.identity.trim().toLowerCase() });
  } catch {
    // no such user: PocketBase answers "Failed to authenticate." as for any wrong login
  }
}

/**
 * Security + cache headers for every response (§5.6).
 * @param {core.RequestEvent} e
 */
function headers(e) {
  const path = e.request?.url?.path ?? ""; // always set for a real request; optional in the generated types
  const h = e.response.header();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  // The admin UI (/_/) relies on inline scripts/styles; the API serves JSON.
  if (!path.startsWith("/_/") && !path.startsWith("/api/")) {
    h.set("Content-Security-Policy", CSP);
    // Only content-hashed names (esbuild "[name]-[hash]", 8 chars) are immutable; dev builds are unhashed.
    if (/^\/assets\/.+-[A-Z0-9]{8}\.(js|css)(\.map)?$/.test(path)) h.set("Cache-Control", "public, max-age=31536000, immutable");
    else h.set("Cache-Control", "no-cache");
  }
}

module.exports = {
  beforeUserSave,
  findLoginByEmail,
  beforeRoomCreate,
  beforeRoomCreateRequest,
  beforeRoomUpdate,
  beforeRoomUpdateRequest,
  beforeMessageCreate,
  afterMessageCreate,
  beforeMessageUpdate,
  beforeMessageUpdateRequest,
  headers,
};
