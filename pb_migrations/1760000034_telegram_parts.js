/// <reference path="../types/pocketbase.d.ts" />
// Telegram → chat (DESIGN.md §26.4): a Telegram message longer than a chat message (4096 characters against 2000)
// comes over as several, in order, instead of cut. tg_messages.part says which of them a row is: 0 the first (the one
// a reply, an edit or a repeat delivery finds), 1, 2… the rest. A Telegram message is then one row per part.

migrate(
  (app) => {
    const tg = app.findCollectionByNameOrId("tg_messages");
    tg.fields.add(new NumberField({ name: "part", onlyInt: true, min: 0 }));
    /** @type {any} */ (tg).indexes = [
      "CREATE UNIQUE INDEX idx_tg_messages_tg ON tg_messages (chat_id, tg_message_id, part)",
      "CREATE INDEX idx_tg_messages_message ON tg_messages (message)",
    ];
    app.save(tg);
  },
  (app) => {
    app.db().newQuery("DELETE FROM tg_messages WHERE part > 0").execute();
    const tg = app.findCollectionByNameOrId("tg_messages");
    tg.fields.removeByName("part");
    /** @type {any} */ (tg).indexes = [
      "CREATE UNIQUE INDEX idx_tg_messages_tg ON tg_messages (chat_id, tg_message_id)",
      "CREATE INDEX idx_tg_messages_message ON tg_messages (message)",
    ];
    app.save(tg);
  },
);
