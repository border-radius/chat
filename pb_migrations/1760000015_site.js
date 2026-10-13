/// <reference path="../types/pocketbase.d.ts" />
// Site settings (DESIGN.md §24): one `site` record, edited by a superuser in the admin UI (Collections → site).
// - `title` and `logo`: the branding shown in the header, on the login page and in the tab's title.
// - `invite_only` + `invite_code`: signups need the code (pb_hooks/lib/site.js). Invite-only without a code closes
//   signups. The code is hidden: only superusers see it.
// Anyone can read the record (guests see the branding and whether signing up needs a code); nobody else can change it.

/** @param {Record<string, unknown>} data */
const siteCollection = (data) => new Collection(/** @type {any} */ (data));

migrate(
  (app) => {
    const site = siteCollection({
      type: "base",
      name: "site",
      listRule: "",
      viewRule: "",
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "text", name: "title", required: true, min: 1, max: 48 },
        {
          type: "file",
          name: "logo",
          maxSelect: 1,
          maxSize: 1024 * 1024,
          mimeTypes: ["image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/gif"],
          protected: false,
        },
        { type: "bool", name: "invite_only" },
        { type: "text", name: "invite_code", hidden: true, max: 100 },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
    });
    app.save(site);

    const rec = new Record(site);
    rec.set("title", "Chat");
    app.save(rec);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("site"));
  },
);
