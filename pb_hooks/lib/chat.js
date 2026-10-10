/// <reference path="../../types/pocketbase.d.ts" />
// Shared logic for main.pb.js. PocketBase hook handlers can't see top-level variables,
// so each handler require()s this module.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
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

/** @param {string} s */
const isBlank = (s) => s.replace(INVISIBLE, "").trim() === "";

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
  const name = record.getString("name").replace(NAME_JUNK, "").trim();
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
 * rooms create/update: clean the name and enforce case-insensitive (Unicode) uniqueness via `name_key`.
 * The unique index on name_key backs this up against races.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function setRoomKey(app, rec) {
  cleanName(rec);
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
 * @param {core.App} app
 * @param {string} roomId
 */
function assertRoomActive(app, roomId) {
  if (!roomId) return; // the relation's own `required` validation reports this
  const room = app.findRecordById("rooms", roomId);
  if (room.getBool("archived")) throw fieldError("room", "This room is archived and read-only.");
}

/** @param {core.Record} record */
function assertText(record) {
  trim(record, "text");
  if (isBlank(record.getString("text"))) throw fieldError("text", "Cannot be blank.");
}

/**
 * The event's record. PocketBase always sets it in record hooks; the generated types mark it optional (a Go pointer).
 * @param {core.RecordEvent} e
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
  assertText(rec);
  assertRoomActive(e.app, rec.getString("room"));
}

/**
 * messages update: soft delete, edit stamp, archived guard (§5.6).
 * @param {core.RecordEvent} e
 */
function beforeMessageUpdate(e) {
  const rec = recordOf(e);
  const orig = rec.original();
  assertRoomActive(e.app, orig.getString("room"));

  if (orig.getBool("deleted")) {
    // Deletion is final; API rules already refuse this, so this only guards superuser edits.
    throw fieldError("deleted", "Deleted messages cannot be changed.");
  }

  if (rec.getBool("deleted")) {
    rec.set("text", "");
    rec.set("deleted_at", new DateTime());
    rec.set("edited_at", orig.get("edited_at"));
    return;
  }

  assertText(rec);
  if (rec.getString("text") !== orig.getString("text")) {
    rec.set("edited_at", new DateTime());
  }
}

/**
 * rooms create: clean the name and check it is unique (§5.2).
 * @param {core.RecordEvent} e
 */
function beforeRoomCreate(e) {
  setRoomKey(e.app, recordOf(e));
}

/**
 * users create/update: clean the display name (§5.1).
 * @param {core.RecordEvent} e
 */
function beforeUserSave(e) {
  cleanName(recordOf(e));
}

/**
 * rooms update: clean + unique name, stamp/clear archived_at when `archived` flips (§5.6).
 * @param {core.RecordEvent} e
 */
function beforeRoomUpdate(e) {
  const rec = recordOf(e);
  setRoomKey(e.app, rec);
  const was = rec.original().getBool("archived");
  const now = rec.getBool("archived");
  if (!was && now) rec.set("archived_at", new DateTime());
  if (was && !now) rec.set("archived_at", "");
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

module.exports = { beforeUserSave, beforeRoomCreate, beforeMessageCreate, beforeMessageUpdate, beforeRoomUpdate, headers };
