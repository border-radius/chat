/// <reference path="../types/pocketbase.d.ts" />
// The room's media grid (DESIGN.md §30) shows square tiles: a "240x240" thumbnail is cropped to the square, centred,
// where the fitted ones (§17.5) would be blurry once cropped.

const BEFORE = ["800x480f", "480x240f"];
const AFTER = [...BEFORE, "240x240"];

/** @param {any} app @param {string[]} thumbs */
function setThumbs(app, thumbs) {
  const messages = app.findCollectionByNameOrId("messages");
  /** @type {any} */ (messages.fields.getByName("files")).thumbs = thumbs;
  app.save(messages);
}

migrate(
  (app) => setThumbs(app, AFTER),
  (app) => setThumbs(app, BEFORE),
);
