/// <reference path="../../types/pocketbase.d.ts" />
// Record helpers shared by the users, rooms and messages hooks: validation errors, names, uploaded file names.

const { clipFileName, isBlank, nameKey, tidy, unescapeUploadName } = require(`${__hooks}/lib/text.js`);

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
 * The event's record. PocketBase always sets it in record hooks; the generated types mark it optional (a Go pointer).
 * @param {{ record?: core.Record | undefined }} e
 */
function recordOf(e) {
  if (!e.record) throw new Error("record hook called without a record");
  return e.record;
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
 * Set `name_key` from the (cleaned) name and enforce case-insensitive (Unicode) uniqueness within `collection`.
 * The unique index on name_key backs this up against races.
 * @param {core.App} app
 * @param {string} collection
 * @param {core.Record} rec
 * @param {string} taken the error message when another record has the name
 */
function setNameKey(app, collection, rec, taken) {
  const key = nameKey(rec.getString("name"));
  rec.set("name_key", key);
  if (key === "") return; // `required` on name reports it
  let clash = null;
  try {
    clash = app.findFirstRecordByFilter(collection, "name_key = {:key} && id != {:id}", { key, id: rec.id });
  } catch {
    clash = null; // no such record
  }
  if (clash) throw fieldError("name", taken, "validation_not_unique");
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
    const original = clipFileName(tidy(unescapeUploadName(f.originalName)));
    f.originalName = original || f.name;
    if (original) names[f.name] = original;
  }
  return names;
}

module.exports = { fieldError, recordOf, cleanName, setNameKey, originalNames };
