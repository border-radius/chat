/// <reference path="../types/pocketbase.d.ts" />
// Message search (DESIGN.md §29): messages.text_key, the text case folded like names are compared (§22.1), set by
// pb_hooks on every save. Searching filters on it (`text_key ~ {:word}`), so "привет" finds "Привет" and "strasse"
// "Straße": SQLite's LIKE only ignores the case of ASCII letters (QA BUG-55). Not hidden, so the list API (and its
// rules) can filter on it; clients never ask for it (MSG_FIELDS).

/**
 * Same as nameKey() in pb_hooks/lib/text.js (migrations can't load the hooks' modules).
 * @param {string} text
 */
function textKey(text) {
  const s = text.replace(/[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "");
  return (typeof s.normalize === "function" ? s.normalize("NFKC") : s).toUpperCase().toLowerCase();
}

/** Messages backfilled per query. */
const BATCH = 500;

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    // NFKC can make text longer (one ligature becomes up to 18 letters): room for any 2000-character message.
    messages.fields.add(new TextField({ name: "text_key", max: 40000 }));
    app.save(messages);

    // Backfill with raw SQL (no hooks: they would stamp edits). Deleted messages and forwards have no text.
    let after = "";
    for (;;) {
      const rows = arrayOf(new DynamicModel({ id: "", text: "" }));
      app
        .db()
        .newQuery("SELECT id, text FROM messages WHERE text != '' AND id > {:after} ORDER BY id LIMIT {:n}")
        .bind({ after, n: BATCH })
        .all(rows);
      for (const r of rows) {
        app
          .db()
          .newQuery("UPDATE messages SET text_key = {:key} WHERE id = {:id}")
          .bind({ key: textKey(r.text), id: r.id })
          .execute();
      }
      if (rows.length < BATCH) break;
      after = rows[rows.length - 1].id;
    }
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("text_key");
    app.save(messages);
  },
);
