/// <reference path="../types/pocketbase.d.ts" />
// Forwards point at the original instead of copying it (DESIGN.md §21.3). `messages.forward_of` is the message a
// forward shows: its text and attachments are the original's as they are now (an edit shows in every forward, a delete
// empties them), and nothing is copied, so forwarding can't multiply what is stored. Only POST /api/chat/forward
// (pb_hooks) sets it; clients can't set or change it.
// - Whoever can see a forward that isn't deleted can view the message it points at, and that message's attachments:
//   the view rule grants it. Nothing else of the original's room: the list rule, which lists a room's messages and
//   feeds their realtime events, is unchanged.
// - Forwards made before this keep their copies. Going down loses what forwards made since show: they hold nothing.

const NO_FORWARD_OF = "@request.body.forward_of:isset = false";
/** Another message of the collection, joined once so every condition below is about the same one. */
const F = "@collection.messages:fwd.";

/**
 * A forward of this message that isn't deleted is in a room the caller can see (CAN_SEE of 1760000014_room_access.js,
 * with the "any of" operators that @collection joins need).
 */
const VIA_FORWARD =
  `(${F}forward_of ?= id && ${F}deleted ?= false && ` +
  `((${F}room.visibility ?= "open" && ${F}room.archived ?= false) || ` +
  `(@request.auth.id != "" && (${F}room.visibility ?!= "private" || ${F}room.members.id ?= @request.auth.id || ${F}room.created_by ?= @request.auth.id))))`;

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(
      new RelationField(/** @type {any} */ ({ name: "forward_of", maxSelect: 1, collectionId: messages.id, cascadeDelete: false })),
    );
    messages.viewRule = `(${messages.listRule}) || ${VIA_FORWARD}`;
    messages.createRule = `${messages.createRule} && ${NO_FORWARD_OF}`;
    messages.updateRule = `${messages.updateRule} && ${NO_FORWARD_OF}`;
    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("forward_of");
    messages.viewRule = messages.listRule;
    messages.createRule = (messages.createRule ?? "").replace(` && ${NO_FORWARD_OF}`, "");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${NO_FORWARD_OF}`, "");
    app.save(messages);
  },
);
