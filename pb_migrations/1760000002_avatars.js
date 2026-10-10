/// <reference path="../types/pocketbase.d.ts" />
// Avatars (DESIGN.md §15.1): configure the built-in users.avatar file field. Raster images only (no SVG),
// 2 MB, square thumbnails for 1× and 2× screens, public.

const AVATAR = {
  maxSelect: 1,
  maxSize: 2 * 1024 * 1024,
  mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  thumbs: ["48x48", "96x96"],
  protected: false,
};

/** PocketBase's defaults for the field, restored on down. */
const DEFAULTS = {
  maxSelect: 1,
  maxSize: 0,
  mimeTypes: ["image/jpeg", "image/png", "image/svg+xml", "image/gif", "image/webp"],
  thumbs: [],
  protected: false,
};

/** @typedef {Parameters<Parameters<typeof migrate>[0]>[0]} AvatarMigrationApp */

/**
 * @param {AvatarMigrationApp} app
 * @param {typeof AVATAR} settings
 */
function configure(app, settings) {
  const users = app.findCollectionByNameOrId("users");
  // The generated types model the Go field struct; the JSVM accepts plain property writes.
  const avatar = /** @type {any} */ (users.fields.getByName("avatar"));
  Object.assign(avatar, settings);
  app.save(users);
}

migrate(
  (app) => configure(app, AVATAR),
  (app) => configure(app, DEFAULTS),
);
