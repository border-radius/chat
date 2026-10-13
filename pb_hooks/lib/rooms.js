/// <reference path="../../types/pocketbase.d.ts" />
// rooms hooks (DESIGN.md §5.2, §16, §23): names, DM fields, members, archive stamps.

const { cleanName, fieldError, recordOf, setNameKey } = require(`${__hooks}/lib/records.js`);
const { stripHashes } = require(`${__hooks}/lib/text.js`);

/** @param {core.Record} room */
const isDm = (room) => room.getString("kind") === "dm";

/**
 * rooms create/update: clean the name and check it is unique.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function setRoomKey(app, rec) {
  cleanName(rec);
  rec.set("name", stripHashes(rec.getString("name")));
  setNameKey(app, "rooms", rec, "Value must be unique.");
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
 * Who is in the room (§23.1): a DM's two members never change. A private room lists its creator and the people they
 * added, each once; other rooms list nobody (their members were only for while they were private).
 * @param {core.Record} rec
 */
function setMembers(rec) {
  if (isDm(rec)) {
    rec.set("visibility", "private");
    return;
  }
  if (!rec.getString("visibility")) rec.set("visibility", "public");
  if (rec.getString("visibility") !== "private") {
    rec.set("members", []);
    return;
  }
  const creator = rec.getString("created_by");
  rec.set("members", [...new Set([creator, ...rec.getStringSlice("members")])].filter(Boolean));
}

/**
 * rooms create: public unless said otherwise; clean the name and check it is unique (§5.2, §16.1).
 * @param {core.RecordEvent} e
 */
function beforeRoomCreate(e) {
  const rec = recordOf(e);
  if (!rec.getString("kind")) rec.set("kind", "public");
  setRoomName(e.app, rec);
  setMembers(rec);
}

/** Fields only the DM route and hooks may set (§16.3). A room's creator may change a private room's members (§23.2). */
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
    if (f === "members" && !isDm(orig)) continue;
    if (dmValue(rec, f) !== dmValue(orig, f)) throw fieldError(f, "This field can't be changed.");
  }
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
  setMembers(rec);
  if (isDm(rec)) return;
  const was = orig.getBool("archived");
  const now = rec.getBool("archived");
  if (!was && now) rec.set("archived_at", new DateTime());
  if (was && !now) rec.set("archived_at", "");
}

module.exports = { isDm, beforeRoomCreate, beforeRoomCreateRequest, beforeRoomUpdate, beforeRoomUpdateRequest };
