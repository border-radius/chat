/// <reference path="../../pb_data/types.d.ts" />
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

function fieldError(field, message) {
  return new BadRequestError("Failed to save record.", {
    [field]: new ValidationError("validation_invalid_value", message),
  });
}

/** Trim a text field in place (required/min validation then rejects blanks). */
function trim(record, field) {
  record.set(field, record.getString(field).trim());
}

function assertRoomActive(app, roomId) {
  if (!roomId) return; // the relation's own `required` validation reports this
  const room = app.findRecordById("rooms", roomId);
  if (room.getBool("archived")) throw fieldError("room", "This room is archived and read-only.");
}

function assertText(record) {
  trim(record, "text");
  if (record.getString("text") === "") throw fieldError("text", "Cannot be blank.");
}

/** messages create: trim + non-empty text, room must be active (§5.6). */
function beforeMessageCreate(e) {
  assertText(e.record);
  assertRoomActive(e.app, e.record.getString("room"));
}

/** messages update: soft delete, edit stamp, archived guard (§5.6). */
function beforeMessageUpdate(e) {
  const rec = e.record;
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

/** rooms update: stamp/clear archived_at when `archived` flips (§5.6). */
function beforeRoomUpdate(e) {
  trim(e.record, "name");
  const was = e.record.original().getBool("archived");
  const now = e.record.getBool("archived");
  if (!was && now) e.record.set("archived_at", new DateTime());
  if (was && !now) e.record.set("archived_at", "");
}

/** Security + cache headers for every response (§5.6). */
function headers(e) {
  const path = e.request.url.path;
  const h = e.response.header();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  // The admin UI (/_/) relies on inline scripts/styles; the API serves JSON.
  if (!path.startsWith("/_/") && !path.startsWith("/api/")) {
    h.set("Content-Security-Policy", CSP);
    if (path.startsWith("/assets/")) h.set("Cache-Control", "public, max-age=31536000, immutable");
    else h.set("Cache-Control", "no-cache");
  }
}

module.exports = { trim, beforeMessageCreate, beforeMessageUpdate, beforeRoomUpdate, headers };
