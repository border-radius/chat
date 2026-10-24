/// <reference path="../types/pocketbase.d.ts" />
// Linked instances (DESIGN.md §33.2, §33.3): no environment variable and no code to pass on.
// - site.federation: the module's switch, ticked by a superuser (Collections → site). The server's address is the
//   Application URL (Settings). Hidden: nobody but superusers needs to know.
// - fed_peers.status "requested": an instance that asked to link with this one, waiting for this side's admin (who
//   accepts by setting it active, or declines by deleting the row). `invite` then holds the asking side's code.
// - A server that ran with FEDERATION_ORIGIN (the first build's switch) keeps linking: that origin becomes the
//   Application URL and `federation` is ticked.

migrate(
  (app) => {
    const site = app.findCollectionByNameOrId("site");
    site.fields.add(new BoolField({ name: "federation", hidden: true }));
    app.save(site);

    const peers = app.findCollectionByNameOrId("fed_peers");
    const status = /** @type {any} */ (peers.fields.getByName("status"));
    status.values = ["invited", "requested", "active", "suspended"];
    app.save(peers);

    const was = $os.getenv("FEDERATION_ORIGIN").trim().replace(/\/+$/, "");
    if (was) {
      const settings = app.settings();
      settings.meta.appURL = was;
      app.save(settings);
      const rec = app.findRecordsByFilter("site", "", "created", 1, 0)[0];
      if (rec) {
        rec.set("federation", true);
        app.save(rec);
      }
    }
  },
  (app) => {
    app.db().newQuery("DELETE FROM fed_peers WHERE status = 'requested'").execute();
    const peers = app.findCollectionByNameOrId("fed_peers");
    const status = /** @type {any} */ (peers.fields.getByName("status"));
    status.values = ["invited", "active", "suspended"];
    app.save(peers);

    const site = app.findCollectionByNameOrId("site");
    site.fields.removeByName("federation");
    app.save(site);
  },
);
