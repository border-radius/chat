/// <reference path="../types/pocketbase.d.ts" />
// Direct messages (DESIGN.md §16): a DM is a room with kind = "dm" and its two members. Public rooms are
// unchanged apart from the new `kind`. Only the POST /api/chat/dms route (pb_hooks) creates DMs.

const SIGNED_IN = '@request.auth.id != ""';
const NO_DM_FIELDS = [
  "@request.body.members:isset = false",
  "@request.body.dm_key:isset = false",
  "@request.body.last_message_at:isset = false",
];
/** The room in `rel` is public, or the caller is one of its members. */
const VISIBLE = (/** @type {string} */ rel) => `(${rel}kind = "public" || ${rel}members.id ?= @request.auth.id)`;

const RULES = {
  rooms: {
    listRule: `${SIGNED_IN} && ${VISIBLE("")}`,
    viewRule: `${SIGNED_IN} && ${VISIBLE("")}`,
    createRule: [
      SIGNED_IN,
      "@request.body.created_by = @request.auth.id",
      "(@request.body.archived:isset = false || @request.body.archived = false)",
      "@request.body.archived_at:isset = false",
      '(@request.body.kind:isset = false || @request.body.kind = "public")',
      ...NO_DM_FIELDS,
    ].join(" && "),
    updateRule: [
      "created_by = @request.auth.id",
      'kind = "public"',
      "@request.body.created_by:isset = false",
      "@request.body.archived_at:isset = false",
      "@request.body.kind:isset = false",
      ...NO_DM_FIELDS,
    ].join(" && "),
  },
  messages: {
    listRule: `${SIGNED_IN} && ${VISIBLE("room.")}`,
    viewRule: `${SIGNED_IN} && ${VISIBLE("room.")}`,
    createRule: [
      SIGNED_IN,
      "@request.body.author = @request.auth.id",
      "@request.body.room.archived = false",
      VISIBLE("@request.body.room."),
      "@request.body.deleted:isset = false",
      "@request.body.deleted_at:isset = false",
      "@request.body.edited_at:isset = false",
    ].join(" && "),
  },
  hidden_rooms: {
    createRule: `${SIGNED_IN} && @request.body.user = @request.auth.id && ${VISIBLE("@request.body.room.")}`,
  },
};

/** The MVP rules (1760000000_init.js), restored on down. */
const MVP_RULES = {
  rooms: {
    listRule: SIGNED_IN,
    viewRule: SIGNED_IN,
    createRule: [
      SIGNED_IN,
      "@request.body.created_by = @request.auth.id",
      "(@request.body.archived:isset = false || @request.body.archived = false)",
      "@request.body.archived_at:isset = false",
    ].join(" && "),
    updateRule: ["created_by = @request.auth.id", "@request.body.created_by:isset = false", "@request.body.archived_at:isset = false"].join(
      " && ",
    ),
  },
  messages: {
    listRule: SIGNED_IN,
    viewRule: SIGNED_IN,
    createRule: [
      SIGNED_IN,
      "@request.body.author = @request.auth.id",
      "@request.body.room.archived = false",
      "@request.body.deleted:isset = false",
      "@request.body.deleted_at:isset = false",
      "@request.body.edited_at:isset = false",
    ].join(" && "),
  },
  hidden_rooms: { createRule: `${SIGNED_IN} && @request.body.user = @request.auth.id` },
};

const DM_LIMIT = { label: "POST /api/chat/dms", audience: "", duration: 60, maxRequests: 10 };

/** @typedef {Parameters<Parameters<typeof migrate>[0]>[0]} DmMigrationApp */

/**
 * @param {DmMigrationApp} app
 * @param {Record<string, Record<string, string>>} rules
 */
function applyRules(app, rules) {
  for (const [name, r] of Object.entries(rules)) {
    const c = app.findCollectionByNameOrId(name);
    Object.assign(c, r);
    app.save(c);
  }
}

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const rooms = app.findCollectionByNameOrId("rooms");
    // DMs have no name (the title is the other member's): required only for public rooms, by pb_hooks.
    /** @type {any} */ (rooms.fields.getByName("name")).required = false;
    rooms.fields.add(new SelectField({ name: "kind", required: true, maxSelect: 1, values: ["public", "dm"] }));
    rooms.fields.add(new RelationField({ name: "members", maxSelect: 2, collectionId: users.id, cascadeDelete: false }));
    rooms.fields.add(new TextField({ name: "dm_key", hidden: true, max: 40 }));
    rooms.fields.add(new DateField({ name: "last_message_at" }));
    app.save(rooms);

    app.db().newQuery("UPDATE rooms SET kind = 'public' WHERE kind = '' OR kind IS NULL").execute();

    const indexed = app.findCollectionByNameOrId("rooms");
    indexed.addIndex("idx_rooms_dm_key", true, "`dm_key`", "`dm_key` != ''");
    // Every DM's name is "": the case-insensitive unique name index only covers named (public) rooms now.
    indexed.removeIndex("idx_rooms_name");
    indexed.addIndex("idx_rooms_name", true, "`name` COLLATE NOCASE", "`name` != ''");
    app.save(indexed);

    applyRules(app, RULES);

    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => r.label !== DM_LIMIT.label);
    settings.rateLimits.rules = [/** @type {any} */ (DM_LIMIT), ...rest];
    app.save(settings);
  },
  // Rolling back turns existing DMs into nameless rooms visible to everyone: delete them first if that matters.
  (app) => {
    applyRules(app, MVP_RULES);
    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.removeIndex("idx_rooms_dm_key");
    rooms.removeIndex("idx_rooms_name");
    rooms.addIndex("idx_rooms_name", true, "`name` COLLATE NOCASE", "");
    for (const n of ["kind", "members", "dm_key", "last_message_at"]) rooms.fields.removeByName(n);
    /** @type {any} */ (rooms.fields.getByName("name")).required = true;
    app.save(rooms);

    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => r.label !== DM_LIMIT.label);
    app.save(settings);
  },
);
