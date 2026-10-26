/// <reference path="../types/pocketbase.d.ts" />
// Telegram bridge (DESIGN.md §26.6): tg_links.anonymous, a link whose group gets the room's messages without their
// authors' names, only what they say.

migrate(
  (app) => {
    const links = app.findCollectionByNameOrId("tg_links");
    links.fields.add(new BoolField({ name: "anonymous" }));
    app.save(links);
  },
  (app) => {
    const links = app.findCollectionByNameOrId("tg_links");
    links.fields.removeByName("anonymous");
    app.save(links);
  },
);
