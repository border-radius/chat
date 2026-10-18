/// <reference path="../types/pocketbase.d.ts" />
// Who can post in a room (DESIGN.md §23.6): everyone who can read it, or only the people its creator chose.
// - `rooms.posting`: "everyone" (the default, and every room from before) or "selected". DMs are always "everyone".
// - `rooms.writers`: who may post when "selected" (up to ROOM_MAX_WRITERS); only the creator changes it. The hooks keep
//   it empty otherwise, always list the creator, and in a private room keep only its members.
// - Posting, editing and deleting a message need it on top of seeing the room. Reacting doesn't: readers may react.

const ROOM_MAX_WRITERS = 100;

/** The caller may post in the room in `rel` (seeing it is checked apart). */
const WRITER = (/** @type {string} */ rel) =>
  `(${rel}posting != "selected" || ${rel}writers.id ?= @request.auth.id || ${rel}created_by = @request.auth.id)`;

const WRITERS_UNSET = "@request.body.writers:isset = false";

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.fields.add(new SelectField({ name: "posting", required: true, maxSelect: 1, values: ["everyone", "selected"] }));
    rooms.fields.add(
      new RelationField(
        /** @type {any} */ ({ name: "writers", maxSelect: ROOM_MAX_WRITERS, collectionId: users.id, cascadeDelete: false }),
      ),
    );
    // A room starts with everyone posting, or only its creator: nobody else is chosen yet.
    rooms.createRule = `${rooms.createRule} && ${WRITERS_UNSET}`;
    app.save(rooms);
    app.db().newQuery("UPDATE rooms SET posting = 'everyone', writers = '[]'").execute();

    const messages = app.findCollectionByNameOrId("messages");
    messages.createRule = `${messages.createRule} && ${WRITER("@request.body.room.")}`;
    // Someone who may no longer post can't edit or delete what they wrote there either, as in an archived room.
    messages.updateRule = `${messages.updateRule} && ${WRITER("room.")}`;
    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.createRule = (messages.createRule ?? "").replace(` && ${WRITER("@request.body.room.")}`, "");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${WRITER("room.")}`, "");
    app.save(messages);

    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.createRule = (rooms.createRule ?? "").replace(` && ${WRITERS_UNSET}`, "");
    rooms.fields.removeByName("writers");
    rooms.fields.removeByName("posting");
    app.save(rooms);
  },
);
