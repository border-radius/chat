/// <reference path="../types/pocketbase.d.ts" />
// Replies (DESIGN.md §19): `messages.reply_to` points at an earlier message of the same room. Set only on create
// (pb_hooks checks the room); never changed afterwards. Deleting the original only soft-deletes it, so the
// relation keeps pointing at its placeholder.

const NO_REPLY_CHANGES = "@request.body.reply_to:isset = false";

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(
      new RelationField(/** @type {any} */ ({ name: "reply_to", maxSelect: 1, collectionId: messages.id, cascadeDelete: false })),
    );
    messages.updateRule = `${messages.updateRule} && ${NO_REPLY_CHANGES}`;
    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("reply_to");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${NO_REPLY_CHANGES}`, "");
    app.save(messages);
  },
);
