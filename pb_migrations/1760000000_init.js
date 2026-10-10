/// <reference path="../pb_data/types.d.ts" />
// Initial schema, API rules and rate limits — DESIGN.md §5.

const AUTH = '@request.auth.id != ""';
const NO_PUBLIC_EMAIL = "(@request.body.emailVisibility:isset = false || @request.body.emailVisibility = false)";

migrate(
  (app) => {
    // users (built-in auth collection, §5.1)
    const users = app.findCollectionByNameOrId("users");
    const name = users.fields.getByName("name");
    name.required = true;
    name.min = 1;
    name.max = 32;
    users.listRule = AUTH;
    users.viewRule = AUTH;
    users.createRule = NO_PUBLIC_EMAIL;
    users.updateRule = `id = @request.auth.id && ${NO_PUBLIC_EMAIL}`;
    users.deleteRule = "id = @request.auth.id";
    app.save(users);

    // rooms (§5.2)
    const rooms = new Collection({
      type: "base",
      name: "rooms",
      listRule: AUTH,
      viewRule: AUTH,
      createRule: [
        AUTH,
        "@request.body.created_by = @request.auth.id",
        "(@request.body.archived:isset = false || @request.body.archived = false)",
        "@request.body.archived_at:isset = false",
      ].join(" && "),
      updateRule: [
        "created_by = @request.auth.id",
        "@request.body.created_by:isset = false",
        "@request.body.archived_at:isset = false",
      ].join(" && "),
      deleteRule: null,
      fields: [
        { type: "text", name: "name", required: true, min: 1, max: 48 },
        { type: "relation", name: "created_by", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: false },
        { type: "bool", name: "archived" },
        { type: "date", name: "archived_at" },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_rooms_name` ON `rooms` (`name` COLLATE NOCASE)"],
    });
    app.save(rooms);

    // messages (§5.3)
    const messages = new Collection({
      type: "base",
      name: "messages",
      listRule: AUTH,
      viewRule: AUTH,
      createRule: [
        AUTH,
        "@request.body.author = @request.auth.id",
        "@request.body.room.archived = false",
        "@request.body.deleted:isset = false",
        "@request.body.deleted_at:isset = false",
        "@request.body.edited_at:isset = false",
      ].join(" && "),
      updateRule: [
        "author = @request.auth.id",
        "room.archived = false",
        "deleted = false",
        "@request.body.author:isset = false",
        "@request.body.room:isset = false",
        "@request.body.edited_at:isset = false",
        "@request.body.deleted_at:isset = false",
        "(@request.body.deleted:isset = false || @request.body.deleted = true)",
      ].join(" && "),
      deleteRule: null,
      fields: [
        { type: "relation", name: "room", required: true, maxSelect: 1, collectionId: rooms.id, cascadeDelete: true },
        { type: "relation", name: "author", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: false },
        // Not `required`: a soft-deleted message has empty text. Non-empty is enforced by pb_hooks.
        { type: "text", name: "text", max: 2000 },
        { type: "date", name: "edited_at" },
        { type: "bool", name: "deleted" },
        { type: "date", name: "deleted_at" },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX `idx_messages_room_created` ON `messages` (`room`, `created`, `id`)"],
    });
    app.save(messages);

    // hidden_rooms (§5.4)
    const hidden = new Collection({
      type: "base",
      name: "hidden_rooms",
      listRule: "user = @request.auth.id",
      viewRule: "user = @request.auth.id",
      createRule: `${AUTH} && @request.body.user = @request.auth.id`,
      updateRule: null,
      deleteRule: "user = @request.auth.id",
      fields: [
        { type: "relation", name: "user", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
        { type: "relation", name: "room", required: true, maxSelect: 1, collectionId: rooms.id, cascadeDelete: true },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_hidden_rooms_user_room` ON `hidden_rooms` (`user`, `room`)"],
    });
    app.save(hidden);

    // rate limits (§5.6): keep PocketBase's defaults, add ours in front.
    const settings = app.settings();
    const ours = [
      { label: "messages:create", audience: "", duration: 5, maxRequests: 10 },
      { label: "users:create", audience: "@guest", duration: 60, maxRequests: 20 },
    ];
    const labels = ours.map((r) => r.label);
    settings.rateLimits.rules = [...ours, ...settings.rateLimits.rules.filter((r) => !labels.includes(r.label))];
    settings.rateLimits.enabled = true;
    app.save(settings);
  },
  (app) => {
    for (const n of ["hidden_rooms", "messages", "rooms"]) {
      app.delete(app.findCollectionByNameOrId(n));
    }
    const users = app.findCollectionByNameOrId("users");
    const name = users.fields.getByName("name");
    name.required = false;
    name.min = 0;
    name.max = 255;
    users.listRule = "id = @request.auth.id";
    users.viewRule = "id = @request.auth.id";
    users.createRule = "";
    users.updateRule = "id = @request.auth.id";
    users.deleteRule = "id = @request.auth.id";
    app.save(users);

    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => !["messages:create", "users:create"].includes(r.label));
    settings.rateLimits.enabled = false;
    app.save(settings);
  },
);
