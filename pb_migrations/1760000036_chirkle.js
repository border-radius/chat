/// <reference path="../types/pocketbase.d.ts" />
// The app is called Chirkle; it was "Chat" until 2026-10-27. A site still titled "Chat", the title it was first
// given (1760000015_site.js), takes the new name. A title an admin chose stays as it is (DESIGN.md §24).

migrate(
  (app) => {
    for (const rec of app.findRecordsByFilter("site", "title = {:old}", "", 0, 0, { old: "Chat" })) {
      if (!rec) continue;
      rec.set("title", "Chirkle");
      app.save(rec);
    }
  },
  (app) => {
    for (const rec of app.findRecordsByFilter("site", "title = {:new}", "", 0, 0, { new: "Chirkle" })) {
      if (!rec) continue;
      rec.set("title", "Chat");
      app.save(rec);
    }
  },
);
