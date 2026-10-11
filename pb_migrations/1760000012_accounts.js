/// <reference path="../types/pocketbase.d.ts" />
// Accounts (DESIGN.md §22):
// - users.name_key: display names are unique, compared like room names ("Ada" = "ADA" = "Ada​"), set by pb_hooks.
// - a rate limit for POST /api/chat/password (changing your password, which checks the current one).

const ACCOUNT_LIMITS = [{ label: "POST /api/chat/password", audience: "", duration: 60, maxRequests: 5 }];
const ACCOUNT_LABELS = ACCOUNT_LIMITS.map((r) => r.label);

/**
 * Same as nameKey() in pb_hooks/lib/chat.js (migrations can't load the hooks' modules).
 * @param {string} name
 */
function nameKey(name) {
  const s = name.replace(/[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "");
  return (typeof s.normalize === "function" ? s.normalize("NFKC") : s).toUpperCase().toLowerCase();
}

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new TextField({ name: "name_key", hidden: true, max: 400 }));
    app.save(users);

    // Backfill with raw SQL (no hooks). Names that already clash keep a key made unique by their id; they may keep
    // their name, but nobody can take it any more.
    const seen = new Set();
    for (const u of app.findAllRecords("users")) {
      if (!u) continue;
      let key = nameKey(u.getString("name"));
      if (key === "") continue;
      if (seen.has(key)) key = `${key}#${u.id}`;
      seen.add(key);
      app.db().newQuery("UPDATE users SET name_key = {:key} WHERE id = {:id}").bind({ key, id: u.id }).execute();
    }

    const withIndex = app.findCollectionByNameOrId("users");
    withIndex.addIndex("idx_users_name_key", true, "`name_key`", "`name_key` != ''");
    app.save(withIndex);

    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => !ACCOUNT_LABELS.includes(r.label));
    settings.rateLimits.rules = [.../** @type {any[]} */ (ACCOUNT_LIMITS), ...rest];
    app.save(settings);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.removeIndex("idx_users_name_key");
    users.fields.removeByName("name_key");
    app.save(users);

    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => !ACCOUNT_LABELS.includes(r.label));
    app.save(settings);
  },
);
