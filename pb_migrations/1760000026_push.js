/// <reference path="../types/pocketbase.d.ts" />
// The Android app's server additions (docs/ANDROID.md §8, §12.4):
// - push_tokens: a device's push registration (an FCM token, or a UnifiedPush endpoint URL), the owner's only: they
//   create, view and delete it; nobody lists them.
// - push_queue: messages whose pushes are still to be sent (pb_hooks/lib/push.js). No API access.
// - site.min_android_version: the oldest app the server still serves (0: any). Readable like the rest of the site.

const OWNER = "user = @request.auth.id";

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const messages = app.findCollectionByNameOrId("messages");
    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "push_tokens",
          listRule: null,
          viewRule: OWNER,
          createRule: `@request.auth.id != "" && @request.auth.collectionName = "users" && ${OWNER}`,
          updateRule: null,
          deleteRule: OWNER,
          fields: [
            { type: "relation", name: "user", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
            { type: "text", name: "token", required: true, min: 1, max: 1024 },
            { type: "select", name: "provider", required: true, maxSelect: 1, values: ["fcm", "unifiedpush"] },
            { type: "autodate", name: "created", onCreate: true, onUpdate: false },
            { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
          ],
          indexes: [
            "CREATE UNIQUE INDEX idx_push_tokens_token ON push_tokens (token)",
            "CREATE INDEX idx_push_tokens_user ON push_tokens (user)",
          ],
        }),
      ),
    );
    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "push_queue",
          listRule: null,
          viewRule: null,
          createRule: null,
          updateRule: null,
          deleteRule: null,
          fields: [
            { type: "relation", name: "message", required: true, maxSelect: 1, collectionId: messages.id, cascadeDelete: true },
            { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          ],
          indexes: ["CREATE INDEX idx_push_queue_created ON push_queue (created)"],
        }),
      ),
    );
    const site = app.findCollectionByNameOrId("site");
    site.fields.add(new NumberField(/** @type {any} */ ({ name: "min_android_version", min: 0, onlyInt: true })));
    app.save(site);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("push_queue"));
    app.delete(app.findCollectionByNameOrId("push_tokens"));
    const site = app.findCollectionByNameOrId("site");
    site.fields.removeByName("min_android_version");
    app.save(site);
  },
);
