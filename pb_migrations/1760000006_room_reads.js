/// <reference path="../types/pocketbase.d.ts" />
// Unread counts (DESIGN.md §18.1): how far each user has read each room. Users can list their own rows (and get
// them live); only POST /api/chat/reads (pb_hooks) writes them, so last_read_at only ever moves forward.

const READ_LIMIT = { label: "POST /api/chat/reads", audience: "", duration: 60, maxRequests: 120 };

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const rooms = app.findCollectionByNameOrId("rooms");
    const reads = new Collection(
      /** @type {any} */ ({
        type: "base",
        name: "room_reads",
        listRule: "user = @request.auth.id",
        viewRule: "user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "relation", name: "user", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
          { type: "relation", name: "room", required: true, maxSelect: 1, collectionId: rooms.id, cascadeDelete: true },
          { type: "date", name: "last_read_at", required: true },
        ],
        indexes: ["CREATE UNIQUE INDEX `idx_room_reads_user_room` ON `room_reads` (`user`, `room`)"],
      }),
    );
    app.save(reads);

    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => r.label !== READ_LIMIT.label);
    settings.rateLimits.rules = [/** @type {any} */ (READ_LIMIT), ...rest];
    app.save(settings);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("room_reads"));
    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => r.label !== READ_LIMIT.label);
    app.save(settings);
  },
);
