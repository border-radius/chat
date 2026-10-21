/// <reference path="../types/pocketbase.d.ts" />
// The media grid's index (DESIGN.md §30.1): one row per image or video a room shows, its own or a forward's (§21.3),
// so the grid reads a room's media a page at a time without looking at its other messages, and the media worker
// (pb_hooks/lib/media.js) knows which files still need their thumbnails or video poster. No API access: the grid
// reads it through GET /api/chat/media/{room}. Kept by the messages hooks; filled here from the messages there are.
//
// - message: the message in the room (a forward, or the message itself); source: the one whose file it is.
// - pos: the file's place in the source's files; sent: the message's `created` (the grid's order, as the room's).
// - ready: the worker is done with it (forwards' rows are: their source's row does the work); poster: a video's
//   poster frame is stored (thumbs_{file}/poster.jpg next to the file).

/** As web/src/lib/files.ts and pb_hooks/lib/media.js say, when this ran. */
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif"];
const VIDEO_EXT = ["mp4", "m4v", "webm", "mov", "ogv"];

/** @param {string[]} exts */
const endsWith = (exts) => `(${exts.map((x) => `f.value LIKE '%.${x}'`).join(" OR ")})`;

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const rooms = app.findCollectionByNameOrId("rooms");
    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "media",
          listRule: null,
          viewRule: null,
          createRule: null,
          updateRule: null,
          deleteRule: null,
          fields: [
            { type: "relation", name: "room", required: true, maxSelect: 1, collectionId: rooms.id, cascadeDelete: true },
            { type: "relation", name: "message", required: true, maxSelect: 1, collectionId: messages.id, cascadeDelete: true },
            { type: "relation", name: "source", required: true, maxSelect: 1, collectionId: messages.id, cascadeDelete: true },
            { type: "text", name: "file", required: true, max: 255 },
            { type: "number", name: "pos", onlyInt: true, min: 0 },
            { type: "bool", name: "video" },
            { type: "date", name: "sent", required: true },
            { type: "bool", name: "ready" },
            { type: "bool", name: "poster" },
          ],
          indexes: [
            "CREATE INDEX idx_media_room ON media (room, sent, message, pos)",
            "CREATE INDEX idx_media_message ON media (message)",
            "CREATE INDEX idx_media_source ON media (source, file)",
            "CREATE INDEX idx_media_pending ON media (sent) WHERE ready = FALSE",
          ],
        }),
      ),
    );

    // Every message there is that shows media and isn't deleted; a forward shows its original's.
    app
      .db()
      .newQuery(
        `INSERT INTO media (id, room, message, source, file, pos, video, sent, ready, poster)
         SELECT substr(lower(hex(randomblob(8))), 1, 15), m.room, m.id, s.id, f.value, CAST(f.key AS INTEGER),
                ${endsWith(VIDEO_EXT)}, m.created, s.id != m.id, FALSE
         FROM messages m
         JOIN messages s ON s.id = (CASE WHEN m.forward_of != '' THEN m.forward_of ELSE m.id END)
         JOIN json_each(CASE WHEN json_valid(s.files) THEN s.files ELSE '[]' END) f
         WHERE m.deleted = FALSE AND s.deleted = FALSE AND (${endsWith(IMAGE_EXT)} OR ${endsWith(VIDEO_EXT)})`,
      )
      .execute();
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("media"));
  },
);
