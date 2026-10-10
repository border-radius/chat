/// <reference path="../types/pocketbase.d.ts" />
// Attachments (DESIGN.md §17.1): up to 4 protected files per message, 8 MB each, thumbnails for images.
// Files never change after sending (only the soft delete wipes them, in pb_hooks).

const FILES = {
  name: "files",
  maxSelect: 4,
  maxSize: 8 * 1024 * 1024,
  protected: true,
  thumbs: ["480x360", "240x180"],
};

const NO_FILE_CHANGES = "@request.body.files:isset = false";

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new FileField(/** @type {any} */ (FILES)));
    messages.updateRule = `${messages.updateRule} && ${NO_FILE_CHANGES}`;
    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("files");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${NO_FILE_CHANGES}`, "");
    app.save(messages);
  },
);
