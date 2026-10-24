/// <reference path="../types/pocketbase.d.ts" />
// Linked instances (DESIGN.md §33, pb_hooks/federation.pb.js): its own collections, all named fed_*, readable and
// writable by superusers only (null rules), and a few fields on the core collections. Without FEDERATION_ORIGIN the
// module registers nothing and these stay empty.
// - fed_peers: an instance this one is paired with (or has invited), its shared secret, and how it is doing.
// - fed_shares: a room shared with a peer, on both sides: offered by the home's superuser, accepted by the peer's.
// - fed_people: who a stand-in user is (a person of a peer), and which of this instance's people a peer knows of.
// - fed_queue: work for the worker: events to send to a peer, files and avatars to fetch from one.
// - fed_seen: the ids of events taken from a peer (3 days), so a repeated delivery is dropped.
// - users.peer / users.instance: a stand-in's peer, and the host it is from (shown on profiles). rooms.peer /
//   rooms.remote_id: a mirror's home and the room's id there. rooms.shared: who else holds the room (shown in its
//   header). messages.remote_id: a copied message's global id (unique per room). Only the module sets them.

/** @param {Record<string, unknown>} data */
const fedCollection = (data) =>
  new Collection(
    /** @type {any} */ ({ type: "base", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...data }),
  );

const F_NAMES = ["fed_seen", "fed_queue", "fed_people", "fed_shares", "fed_peers"];

const F_STAMPS = [
  { type: "autodate", name: "created", onCreate: true, onUpdate: false },
  { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
];

/** No client sets the module's fields. */
const F_USERS_UNSET = "@request.body.peer:isset = false && @request.body.instance:isset = false";
const F_ROOMS_UNSET = "@request.body.peer:isset = false && @request.body.remote_id:isset = false && @request.body.shared:isset = false";
const F_MESSAGES_UNSET = "@request.body.remote_id:isset = false";

/** Server requests come from a peer's address: held apart from what people send. */
const F_LIMIT = { label: "/api/fed/", audience: "", duration: 60, maxRequests: 600 };

/**
 * @param {string | null | undefined} rule
 * @param {string} extra
 * @returns {any}
 */
const andRule = (rule, extra) => (rule ? `${rule} && ${extra}` : rule);

/**
 * @param {string | null | undefined} rule
 * @param {string} extra
 * @returns {any}
 */
const dropRule = (rule, extra) => (rule ? rule.replace(` && ${extra}`, "") : rule);

migrate(
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    const users = app.findCollectionByNameOrId("users");
    const messages = app.findCollectionByNameOrId("messages");

    const peers = fedCollection({
      name: "fed_peers",
      fields: [
        // https://b.example: where it is, and who it is (X-Fed-Origin).
        { type: "text", name: "origin", required: true, max: 255 },
        // B: what its people's names end in here ("Ann (B)").
        { type: "text", name: "label", required: true, min: 1, max: 8 },
        { type: "text", name: "secret", max: 128, hidden: true },
        { type: "select", name: "status", maxSelect: 1, values: ["invited", "active", "suspended"] },
        // People may open DMs across (both sides must tick it).
        { type: "bool", name: "dms" },
        // On the inviting side, the code to give the peer's admin, until it is used or expires; on the joining side,
        // the code typed in (cleared once paired).
        { type: "text", name: "invite", max: 64 },
        { type: "date", name: "invite_expires" },
        // Its site name, as it said when pairing.
        { type: "text", name: "name", max: 255 },
        { type: "date", name: "last_ok" },
        { type: "text", name: "last_error", max: 1000 },
        ...F_STAMPS,
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_fed_peers_origin ON fed_peers (origin)",
        "CREATE UNIQUE INDEX idx_fed_peers_label ON fed_peers (label COLLATE NOCASE)",
      ],
    });
    app.save(peers);

    app.save(
      fedCollection({
        name: "fed_shares",
        fields: [
          // Here: the room (the home's own, or the mirror). Empty on the peer's side until it is accepted.
          { type: "relation", name: "room", maxSelect: 1, collectionId: rooms.id, cascadeDelete: true },
          { type: "relation", name: "peer", required: true, maxSelect: 1, collectionId: peers.id, cascadeDelete: true },
          // On a mirror's side: the room's global id at its home (id@host).
          { type: "text", name: "remote_id", max: 300 },
          { type: "select", name: "state", maxSelect: 1, values: ["offered", "active", "ended"] },
          // On a mirror's side: ticked by its superuser to take the room.
          { type: "bool", name: "accepted" },
          // The home's room, as it was offered: what the peer's admin decides on.
          { type: "text", name: "name", max: 255 },
          { type: "text", name: "kind", max: 16 },
          { type: "text", name: "visibility", max: 16 },
          { type: "text", name: "last_error", max: 1000 },
          ...F_STAMPS,
        ],
        indexes: [
          "CREATE INDEX idx_fed_shares_room ON fed_shares (room)",
          "CREATE INDEX idx_fed_shares_peer_remote ON fed_shares (peer, remote_id)",
        ],
      }),
    );

    app.save(
      fedCollection({
        name: "fed_people",
        fields: [
          { type: "relation", name: "peer", required: true, maxSelect: 1, collectionId: peers.id, cascadeDelete: true },
          // Their global id: id@host of the instance they are on.
          { type: "text", name: "remote", required: true, max: 300 },
          { type: "relation", name: "user", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
          // "standin": `user` is the peer's person here. "known": `user` is one of ours, and the peer has heard of them
          // (it is told when their profile changes).
          { type: "select", name: "kind", required: true, maxSelect: 1, values: ["standin", "known"] },
          // A stand-in's name and DM setting on their own instance, and which avatar it has (the peer's key for it).
          { type: "text", name: "name", max: 255 },
          { type: "bool", name: "no_dms" },
          { type: "text", name: "avatar", max: 255 },
          ...F_STAMPS,
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_fed_people_remote ON fed_people (peer, remote)",
          "CREATE INDEX idx_fed_people_user ON fed_people (user)",
        ],
      }),
    );

    app.save(
      fedCollection({
        name: "fed_queue",
        fields: [
          { type: "relation", name: "peer", required: true, maxSelect: 1, collectionId: peers.id, cascadeDelete: true },
          // event: one to send. fetch: a message that came with files, saved once they are fetched. avatar: a
          // stand-in's picture to fetch.
          { type: "select", name: "op", required: true, maxSelect: 1, values: ["event", "fetch", "avatar"] },
          { type: "json", name: "payload", maxSize: 1 << 20 },
          // The order things are sent in: queued in one transaction, rows can share a created millisecond.
          { type: "number", name: "seq", onlyInt: true },
          { type: "number", name: "tries", onlyInt: true },
          { type: "date", name: "next_at" },
          { type: "date", name: "locked_until" },
          { type: "text", name: "error", max: 1000 },
          ...F_STAMPS,
        ],
        indexes: [
          "CREATE INDEX idx_fed_queue_peer ON fed_queue (peer, op, seq)",
          "CREATE INDEX idx_fed_queue_created ON fed_queue (created)",
        ],
      }),
    );

    app.save(
      fedCollection({
        name: "fed_seen",
        fields: [
          { type: "relation", name: "peer", required: true, maxSelect: 1, collectionId: peers.id, cascadeDelete: true },
          { type: "text", name: "event", required: true, max: 64 },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_fed_seen_event ON fed_seen (peer, event)",
          "CREATE INDEX idx_fed_seen_created ON fed_seen (created)",
        ],
      }),
    );

    users.fields.add(new RelationField({ name: "peer", maxSelect: 1, collectionId: peers.id, hidden: true }));
    users.fields.add(new TextField({ name: "instance", max: 255 }));
    users.createRule = andRule(users.createRule, F_USERS_UNSET);
    users.updateRule = andRule(users.updateRule, F_USERS_UNSET);
    app.save(users);

    rooms.fields.add(new RelationField({ name: "peer", maxSelect: 1, collectionId: peers.id, hidden: true }));
    rooms.fields.add(new TextField({ name: "remote_id", max: 300, hidden: true }));
    rooms.fields.add(new JSONField({ name: "shared", maxSize: 8192 }));
    rooms.createRule = andRule(rooms.createRule, F_ROOMS_UNSET);
    rooms.updateRule = andRule(rooms.updateRule, F_ROOMS_UNSET);
    app.save(rooms);

    messages.fields.add(new TextField({ name: "remote_id", max: 300, hidden: true }));
    /** @type {any} */ (messages).indexes = [
      .../** @type {string[]} */ (/** @type {any} */ (messages).indexes),
      "CREATE UNIQUE INDEX idx_messages_remote ON messages (room, remote_id) WHERE remote_id != ''",
    ];
    messages.createRule = andRule(messages.createRule, F_MESSAGES_UNSET);
    messages.updateRule = andRule(messages.updateRule, F_MESSAGES_UNSET);
    app.save(messages);

    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => r.label !== F_LIMIT.label);
    settings.rateLimits.rules = [/** @type {any} */ (F_LIMIT), ...rest];
    app.save(settings);
  },
  (app) => {
    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => r.label !== F_LIMIT.label);
    app.save(settings);

    const messages = app.findCollectionByNameOrId("messages");
    messages.createRule = dropRule(messages.createRule, F_MESSAGES_UNSET);
    messages.updateRule = dropRule(messages.updateRule, F_MESSAGES_UNSET);
    /** @type {any} */ (messages).indexes = /** @type {string[]} */ (/** @type {any} */ (messages).indexes).filter(
      (i) => !i.includes("idx_messages_remote"),
    );
    messages.fields.removeByName("remote_id");
    app.save(messages);

    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.createRule = dropRule(rooms.createRule, F_ROOMS_UNSET);
    rooms.updateRule = dropRule(rooms.updateRule, F_ROOMS_UNSET);
    for (const f of ["peer", "remote_id", "shared"]) rooms.fields.removeByName(f);
    app.save(rooms);

    const users = app.findCollectionByNameOrId("users");
    users.createRule = dropRule(users.createRule, F_USERS_UNSET);
    users.updateRule = dropRule(users.updateRule, F_USERS_UNSET);
    for (const f of ["peer", "instance"]) users.fields.removeByName(f);
    app.save(users);

    for (const name of F_NAMES) app.delete(app.findCollectionByNameOrId(name));
  },
);
