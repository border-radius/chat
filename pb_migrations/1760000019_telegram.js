/// <reference path="../types/pocketbase.d.ts" />
// Telegram bridge (DESIGN.md §26, pb_hooks/telegram.pb.js): its own collections, all named tg_*, readable and writable by
// superusers only (null rules). Nothing outside the bridge reads them, so removing the bridge can leave them, or go down
// this migration to drop them.
// - tg_links: a Telegram group and the room it is linked to. The bridge adds a row (no room, disabled) for every group
//   it is added to; a superuser picks the room and enables it in the admin UI.
// - tg_people: a Telegram sender and the stand-in user ("Ann (TG)") whose name their messages show under.
// - tg_messages: which Telegram messages a chat message is, both ways, for replies, edits and deletes.
// - tg_queue: work for the bridge's worker: messages to send to Telegram, edits and deletes to pass on, and the items
//   of a Telegram album waiting for the rest of it.

/** @param {Record<string, unknown>} data */
const tgCollection = (data) =>
  new Collection(
    /** @type {any} */ ({ type: "base", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...data }),
  );

const NAMES = ["tg_queue", "tg_messages", "tg_people", "tg_links"];

migrate(
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    const users = app.findCollectionByNameOrId("users");
    const messages = app.findCollectionByNameOrId("messages");
    const stamps = [
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ];

    app.save(
      tgCollection({
        name: "tg_links",
        fields: [
          { type: "text", name: "chat_id", required: true, max: 32 },
          { type: "text", name: "title", max: 255 },
          { type: "relation", name: "room", maxSelect: 1, collectionId: rooms.id, cascadeDelete: true },
          { type: "bool", name: "enabled" },
          ...stamps,
        ],
        indexes: ["CREATE UNIQUE INDEX idx_tg_links_chat ON tg_links (chat_id)", "CREATE INDEX idx_tg_links_room ON tg_links (room)"],
      }),
    );

    app.save(
      tgCollection({
        name: "tg_people",
        fields: [
          { type: "text", name: "tg_user_id", required: true, max: 32 },
          { type: "relation", name: "user", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
          { type: "text", name: "name", max: 255 },
          { type: "text", name: "username", max: 64 },
          { type: "text", name: "photo", max: 255 },
          { type: "date", name: "photo_checked" },
          ...stamps,
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_tg_people_tg_user ON tg_people (tg_user_id)",
          "CREATE UNIQUE INDEX idx_tg_people_user ON tg_people (user)",
        ],
      }),
    );

    app.save(
      tgCollection({
        name: "tg_messages",
        fields: [
          { type: "relation", name: "message", required: true, maxSelect: 1, collectionId: messages.id, cascadeDelete: true },
          { type: "text", name: "chat_id", required: true, max: 32 },
          { type: "number", name: "tg_message_id", required: true, onlyInt: true },
          { type: "select", name: "direction", required: true, maxSelect: 1, values: ["in", "out"] },
          // Which Telegram message holds the text: "text" (a message) or "caption" (a file's); "media" holds none.
          { type: "select", name: "kind", required: true, maxSelect: 1, values: ["text", "caption", "media"] },
          ...stamps,
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_tg_messages_tg ON tg_messages (chat_id, tg_message_id)",
          "CREATE INDEX idx_tg_messages_message ON tg_messages (message)",
        ],
      }),
    );

    app.save(
      tgCollection({
        name: "tg_queue",
        fields: [
          { type: "select", name: "op", required: true, maxSelect: 1, values: ["send", "edit", "delete", "album"] },
          // send, edit, delete: the chat message.
          { type: "text", name: "message", max: 15 },
          { type: "text", name: "chat_id", max: 32 },
          // album: the media_group_id, and the Telegram message itself.
          { type: "text", name: "album", max: 64 },
          { type: "json", name: "payload", maxSize: 65536 },
          { type: "number", name: "tries", onlyInt: true },
          { type: "date", name: "next_at" },
          { type: "date", name: "locked_until" },
          { type: "text", name: "error", max: 1000 },
          ...stamps,
        ],
        indexes: [
          "CREATE INDEX idx_tg_queue_created ON tg_queue (created)",
          "CREATE INDEX idx_tg_queue_album ON tg_queue (chat_id, album)",
        ],
      }),
    );
  },
  (app) => {
    for (const name of NAMES) app.delete(app.findCollectionByNameOrId(name));
  },
);
