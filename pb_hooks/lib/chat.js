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
 * @param {string} field
 * @param {string} message
 */
function fieldError(field, message) {
  return new BadRequestError("Failed to save record.", {
    [field]: new ValidationError("validation_invalid_value", message),
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
  if (record.getString("text") === "") throw fieldError("text", "Cannot be blank.");
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
 * rooms update: stamp/clear archived_at when `archived` flips (§5.6).
 * @param {core.RecordEvent} e
 */
function beforeRoomUpdate(e) {
  const rec = recordOf(e);
  trim(rec, "name");
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

module.exports = { trim, beforeMessageCreate, beforeMessageUpdate, beforeRoomUpdate, headers };
