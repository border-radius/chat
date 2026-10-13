/// <reference path="../types/pocketbase.d.ts" />
// Fixes from the QA pass (DESIGN.md §5.2, §5.5, §5.6):
// - rooms.name_key: Unicode-aware unique room names ("Über" = "über", "Straße" = "STRASSE"), set by pb_hooks.
// - users can't delete their own account through the API: their messages and rooms reference them
//   (required relations), so the delete always failed for anyone who had posted.
// - rate limits for message edits/deletes and for room creation.

const NEW_LIMITS = [
  { label: "messages:update", audience: "", duration: 10, maxRequests: 20 },
  { label: "rooms:create", audience: "", duration: 60, maxRequests: 5 },
];

/**
 * Same as nameKey() in pb_hooks/lib/text.js (migrations can't load the hooks' modules).
 * @param {string} name
 */
function roomKey(name) {
  const s = name.replace(/[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "");
  return (typeof s.normalize === "function" ? s.normalize("NFKC") : s).toUpperCase().toLowerCase();
}

migrate(
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.fields.add(new TextField({ name: "name_key", hidden: true, max: 400 }));
    app.save(rooms);

    // Backfill with raw SQL (no hooks). Names that already clash keep a key made unique by their id.
    const seen = new Set();
    for (const r of app.findAllRecords("rooms")) {
      if (!r) continue;
      let key = roomKey(r.getString("name"));
      if (seen.has(key)) key = `${key}#${r.id}`;
      seen.add(key);
      app.db().newQuery("UPDATE rooms SET name_key = {:key} WHERE id = {:id}").bind({ key, id: r.id }).execute();
    }

    const withIndex = app.findCollectionByNameOrId("rooms");
    withIndex.addIndex("idx_rooms_name_key", true, "`name_key`", "`name_key` != ''");
    app.save(withIndex);

    const users = app.findCollectionByNameOrId("users");
    // null = superusers only. The generated type says string (a Go *string), so cast.
    /** @type {any} */ (users).deleteRule = null;
    app.save(users);

    const settings = app.settings();
    const labels = NEW_LIMITS.map((r) => r.label);
    const rest = settings.rateLimits.rules.filter((r) => !labels.includes(r.label));
    // Ours first, as in the init migration. Plain objects work here; the generated type is the Go struct.
    settings.rateLimits.rules = [.../** @type {any[]} */ (NEW_LIMITS), ...rest];
    app.save(settings);
  },
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.removeIndex("idx_rooms_name_key");
    rooms.fields.removeByName("name_key");
    app.save(rooms);

    const users = app.findCollectionByNameOrId("users");
    users.deleteRule = "id = @request.auth.id";
    app.save(users);

    const settings = app.settings();
    const labels = NEW_LIMITS.map((r) => r.label);
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => !labels.includes(r.label));
    app.save(settings);
  },
);
