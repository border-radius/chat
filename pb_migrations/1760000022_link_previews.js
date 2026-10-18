/// <reference path="../types/pocketbase.d.ts" />
// Link previews (DESIGN.md §28): what the links in a message show under it, a favicon and a title each.
// - messages.previews: [{ url, title, icon }], set by the server only (pb_hooks/lib/previews.js); icon is a data: URL.
// - link_queue: messages whose links the previews worker is still to look at. No API access.

const NO_PREVIEWS = "@request.body.previews:isset = false";

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new JSONField(/** @type {any} */ ({ name: "previews", maxSize: 131072 })));
    messages.createRule = `${messages.createRule} && ${NO_PREVIEWS}`;
    messages.updateRule = `${messages.updateRule} && ${NO_PREVIEWS}`;
    app.save(messages);

    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "link_queue",
          listRule: null,
          viewRule: null,
          createRule: null,
          updateRule: null,
          deleteRule: null,
          fields: [
            { type: "relation", name: "message", required: true, maxSelect: 1, collectionId: messages.id, cascadeDelete: true },
            { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          ],
          indexes: ["CREATE INDEX idx_link_queue_created ON link_queue (created)"],
        }),
      ),
    );
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("link_queue"));
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("previews");
    messages.createRule = (messages.createRule ?? "").replace(` && ${NO_PREVIEWS}`, "");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${NO_PREVIEWS}`, "");
    app.save(messages);
  },
);
