/// <reference path="../types/pocketbase.d.ts" />
// Attachment thumbnails keep the image's aspect ratio (DESIGN.md §17.5): "f" fits the image inside the box rather
// than cropping it to the box.

const FIT = ["800x480f", "480x240f"];
const CROP = ["480x360", "240x180"];

/** @param {any} app @param {string[]} thumbs */
function setThumbs(app, thumbs) {
  const messages = app.findCollectionByNameOrId("messages");
  /** @type {any} */ (messages.fields.getByName("files")).thumbs = thumbs;
  app.save(messages);
}

migrate(
  (app) => setThumbs(app, FIT),
  (app) => setThumbs(app, CROP),
);
