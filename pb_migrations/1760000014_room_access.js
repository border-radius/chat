/// <reference path="../types/pocketbase.d.ts" />
// Room access (DESIGN.md §23): a room's creator chooses who can see it.
// - `rooms.visibility`: "private" (only its members: the people the creator added, and the creator), "public" (every
//   signed-in user, as before) or "open" (Open Air: also readable without an account, while it isn't archived). DMs
//   are "private" to their two members. Existing rooms are backfilled.
// - `rooms.members` holds a private room's members (up to ROOM_MAX_MEMBERS); only the creator changes them, through the
//   rooms API. The hooks keep it empty for other rooms and always list the creator in a private one.
// - Guests (no session) can list and read Open Air rooms, their messages and their attachments, and see the profile
//   (name, avatar) of a user whose id they have, so messages show their authors. They can't write anything.
// - Writing in a room (a message, an edit, hiding it) needs the same access as seeing it, signed in.

const AUTHED = '@request.auth.id != ""';
const ROOM_MAX_MEMBERS = 100;

/** Signed in, and the room in `rel` is public or open, or the caller is one of its members (or its creator). */
const IS_MEMBER = (/** @type {string} */ rel) =>
  `(${AUTHED} && (${rel}visibility != "private" || ${rel}members.id ?= @request.auth.id || ${rel}created_by = @request.auth.id))`;
/** MEMBER, or the room in `rel` is Open Air (and not archived): anyone can read it. */
const CAN_SEE = (/** @type {string} */ rel) => `((${rel}visibility = "open" && ${rel}archived = false) || ${IS_MEMBER(rel)})`;

/** The visibility conditions of 1760000003_direct_messages.js, replaced in place (later migrations appended to the rules). */
const OLD_VISIBLE = (/** @type {string} */ rel) => `(${rel}kind = "public" || ${rel}members.id ?= @request.auth.id)`;
const OLD_SEE = (/** @type {string} */ rel) => `${AUTHED} && ${OLD_VISIBLE(rel)}`;

/** @typedef {Parameters<Parameters<typeof migrate>[0]>[0]} AccessMigrationApp */

/**
 * Replace `from` by `to` in `rule`, which must contain it (a rule changed by hand would otherwise lose its guard).
 * @param {string | null | undefined} rule
 * @param {string} from
 * @param {string} to
 */
function swap(rule, from, to) {
  const r = rule ?? "";
  if (!r.includes(from)) throw new Error(`room access migration: expected ${from} in ${r}`);
  return r.replace(from, to);
}

/**
 * @param {AccessMigrationApp} app
 * @param {boolean} up
 */
function setRules(app, up) {
  const see = (/** @type {string} */ rel) => (up ? CAN_SEE(rel) : OLD_SEE(rel));
  const rooms = app.findCollectionByNameOrId("rooms");
  rooms.listRule = see("");
  rooms.viewRule = see("");
  // A room's creator may now set its members (§23.2): the hooks check them.
  const MEMBERS_FIXED = " && @request.body.members:isset = false";
  rooms.updateRule = up ? swap(rooms.updateRule, MEMBERS_FIXED, "") : `${rooms.updateRule}${MEMBERS_FIXED}`;
  app.save(rooms);

  const messages = app.findCollectionByNameOrId("messages");
  messages.listRule = see("room.");
  messages.viewRule = see("room.");
  messages.createRule = up
    ? swap(messages.createRule, OLD_VISIBLE("@request.body.room."), IS_MEMBER("@request.body.room."))
    : swap(messages.createRule, IS_MEMBER("@request.body.room."), OLD_VISIBLE("@request.body.room."));
  // Someone taken out of a private room can't edit (or delete) what they wrote there any more: they can't see it.
  const STILL_MEMBER = ` && ${IS_MEMBER("room.")}`;
  messages.updateRule = up ? `${messages.updateRule}${STILL_MEMBER}` : swap(messages.updateRule, STILL_MEMBER, "");
  app.save(messages);

  const hidden = app.findCollectionByNameOrId("hidden_rooms");
  hidden.createRule = up
    ? swap(hidden.createRule, OLD_VISIBLE("@request.body.room."), IS_MEMBER("@request.body.room."))
    : swap(hidden.createRule, IS_MEMBER("@request.body.room."), OLD_VISIBLE("@request.body.room."));
  app.save(hidden);

  // Guests see who wrote a message (expand=author needs the users view rule). Listing (and so searching) users still
  // needs a session: nobody can enumerate the accounts.
  const users = app.findCollectionByNameOrId("users");
  users.viewRule = up ? "" : AUTHED;
  app.save(users);
}

migrate(
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.fields.add(new SelectField({ name: "visibility", required: true, maxSelect: 1, values: ["public", "private", "open"] }));
    /** @type {any} */ (rooms.fields.getByName("members")).maxSelect = ROOM_MAX_MEMBERS;
    app.save(rooms);
    app.db().newQuery("UPDATE rooms SET visibility = CASE WHEN kind = 'dm' THEN 'private' ELSE 'public' END").execute();
    setRules(app, true);
  },
  (app) => {
    setRules(app, false);
    // Private rooms would otherwise become visible to everyone: they are deleted with their messages first if that
    // matters. Members beyond a DM's two are dropped.
    app.db().newQuery("UPDATE rooms SET members = '[]' WHERE kind != 'dm'").execute();
    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.fields.removeByName("visibility");
    /** @type {any} */ (rooms.fields.getByName("members")).maxSelect = 2;
    app.save(rooms);
  },
);
