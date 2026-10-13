/// <reference path="../types/pocketbase.d.ts" />
// Bigger attachments (DESIGN.md §17.1): up to 10 files per message, 20 MB each, as many and as large as a Telegram
// album the bridge (§26) brings over. The request body limit grows with them (pb_hooks/lib/http.js MESSAGE_BODY_LIMIT).
// Going down keeps the files already stored: PocketBase checks the limits on uploads only.

/** @typedef {Parameters<Parameters<typeof migrate>[0]>[0]} MigrationApp */

/**
 * @param {MigrationApp} app
 * @param {number} maxSelect
 * @param {number} maxSize
 */
function setLimits(app, maxSelect, maxSize) {
  const messages = app.findCollectionByNameOrId("messages");
  const files = /** @type {core.FileField} */ (messages.fields.getByName("files"));
  files.maxSelect = maxSelect;
  files.maxSize = maxSize;
  app.save(messages);
}

migrate(
  (app) => setLimits(app, 10, 20 * 1024 * 1024),
  (app) => setLimits(app, 4, 8 * 1024 * 1024),
);
