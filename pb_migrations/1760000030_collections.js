/// <reference path="../types/pocketbase.d.ts" />
// Media collections (DESIGN.md §31): a user's own sets of images and videos, public or private, saved from the chat
// (a copy of the file, so it outlives the message and is seen by the collection's rules, not the room's) and attached
// to messages from there (copied again into the message). Others can subscribe to a public collection and see what
// is new in it.
//
// - collections: the owner manages them through the records API (rules below, pb_hooks/lib/collections.js checks the
//   name and the limits); `items` and `last_added` are kept by the routes that add and remove items.
// - collection_items: one file each, protected (file tokens check this collection's view rule, §17.3). Written only by
//   the routes. `origin` (hidden) says which message file or item it was copied from, so the same one isn't saved twice.
// - collection_subs: who follows which public collection, and up to when they have seen it (as room_reads, §18.1).
// - messages.file_sources: stored file name → the collection its file was attached from, set only by the create hook.

const C_NO_SOURCES = "@request.body.file_sources:isset = false";
const C_OWNER = "owner = @request.auth.id";
const C_VISIBLE = `public = true || ${C_OWNER}`;
const C_KEPT = "@request.body.items:isset = false && @request.body.last_added:isset = false && @request.body.name_key:isset = false";

const C_LIMITS = [
  { label: "collections:create", audience: "", duration: 60, maxRequests: 10 },
  { label: "POST /api/chat/items", audience: "", duration: 60, maxRequests: 30 },
  { label: "POST /api/chat/subs", audience: "", duration: 60, maxRequests: 60 },
];

/** The thumbnails of messages.files (§17.5, §30.1): an item attached to a message is shown at the same sizes. */
const C_THUMBS = ["800x480f", "480x240f", "240x240"];

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const collections = new Collection(
      /** @type {any} */ ({
        type: "base",
        name: "collections",
        listRule: C_VISIBLE,
        viewRule: C_VISIBLE,
        createRule: `@request.auth.id != "" && @request.body.owner = @request.auth.id && ${C_KEPT}`,
        updateRule: `${C_OWNER} && @request.body.owner:isset = false && ${C_KEPT}`,
        deleteRule: C_OWNER,
        fields: [
          { type: "relation", name: "owner", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
          { type: "text", name: "name", required: true, max: 60 },
          { type: "text", name: "name_key", max: 240, hidden: true },
          { type: "bool", name: "public" },
          { type: "number", name: "items", onlyInt: true, min: 0 },
          { type: "date", name: "last_added" },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_collections_owner_name ON collections (owner, name_key)"],
      }),
    );
    app.save(collections);

    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "collection_items",
          listRule: "collection.public = true || collection.owner = @request.auth.id",
          viewRule: "collection.public = true || collection.owner = @request.auth.id",
          createRule: null,
          updateRule: null,
          deleteRule: null,
          fields: [
            { type: "relation", name: "collection", required: true, maxSelect: 1, collectionId: collections.id, cascadeDelete: true },
            {
              type: "file",
              name: "file",
              required: true,
              maxSelect: 1,
              maxSize: 20 * 1024 * 1024,
              protected: true,
              thumbs: C_THUMBS,
            },
            { type: "text", name: "name", max: 200 },
            { type: "bool", name: "video" },
            { type: "bool", name: "poster" },
            { type: "bool", name: "ready", hidden: true },
            { type: "text", name: "origin", max: 300, hidden: true },
            { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          ],
          indexes: [
            "CREATE INDEX idx_collection_items_collection ON collection_items (collection, created)",
            "CREATE UNIQUE INDEX idx_collection_items_origin ON collection_items (collection, origin) WHERE origin != ''",
            "CREATE INDEX idx_collection_items_pending ON collection_items (created) WHERE ready = FALSE",
          ],
        }),
      ),
    );

    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "collection_subs",
          listRule: "user = @request.auth.id",
          viewRule: "user = @request.auth.id",
          createRule: null,
          updateRule: null,
          deleteRule: null,
          fields: [
            { type: "relation", name: "user", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
            { type: "relation", name: "collection", required: true, maxSelect: 1, collectionId: collections.id, cascadeDelete: true },
            { type: "date", name: "seen_at", required: true },
            { type: "autodate", name: "created", onCreate: true, onUpdate: false },
            { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
          ],
          indexes: [
            "CREATE UNIQUE INDEX idx_collection_subs_user ON collection_subs (user, collection)",
            "CREATE INDEX idx_collection_subs_collection ON collection_subs (collection)",
          ],
        }),
      ),
    );

    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new JSONField({ name: "file_sources", maxSize: 4096 }));
    messages.createRule = `${messages.createRule} && ${C_NO_SOURCES}`;
    messages.updateRule = `${messages.updateRule} && ${C_NO_SOURCES}`;
    app.save(messages);

    const settings = app.settings();
    const labels = C_LIMITS.map((l) => l.label);
    settings.rateLimits.rules = [.../** @type {any[]} */ (C_LIMITS), ...settings.rateLimits.rules.filter((r) => !labels.includes(r.label))];
    app.save(settings);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("file_sources");
    messages.createRule = (messages.createRule ?? "").replace(` && ${C_NO_SOURCES}`, "");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${C_NO_SOURCES}`, "");
    app.save(messages);
    for (const name of ["collection_subs", "collection_items", "collections"]) app.delete(app.findCollectionByNameOrId(name));
    const settings = app.settings();
    const labels = C_LIMITS.map((l) => l.label);
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => !labels.includes(r.label));
    app.save(settings);
  },
);
