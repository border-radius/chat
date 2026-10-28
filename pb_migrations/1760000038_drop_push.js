/// <reference path="../types/pocketbase.d.ts" />
// Push notifications removed (docs/REFACTOR.md round 4): since docs/ANDROID.md §21 the app checks for notifications
// itself, so nothing registered push tokens any more and the push worker sent nothing. push_tokens and push_queue go;
// site.min_android_version (same migration as them, 1760000026) stays.

const OWNER = "user = @request.auth.id";

migrate(
  (app) => {
    for (const name of ["push_queue", "push_tokens"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch {
        // never made
      }
    }
  },
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
            "CREATE UNIQUE INDEX idx_push_tokens_token_user ON push_tokens (token, user)",
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
  },
);
