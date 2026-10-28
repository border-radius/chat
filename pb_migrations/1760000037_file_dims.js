/// <reference path="../types/pocketbase.d.ts" />
// Attachment shapes (DESIGN.md §17.5): `messages.file_dims` maps a stored image or video name → [width, height] as it
// is shown, so its tile has its size before it loads. The create hook sets an image's from its header; the media worker
// (pb_hooks/lib/media.js) a video's from its poster, and those of files sent before this from theirs: `media.sized`
// says it has looked at the row's file. A forward's rows are sized already: its original's rows do the work.

const C_NO_DIMS = "@request.body.file_dims:isset = false";

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new JSONField({ name: "file_dims", maxSize: 4096 }));
    messages.createRule = `${messages.createRule} && ${C_NO_DIMS}`;
    messages.updateRule = `${messages.updateRule} && ${C_NO_DIMS}`;
    app.save(messages);

    const media = app.findCollectionByNameOrId("media");
    media.fields.add(new BoolField({ name: "sized" }));
    media.addIndex("idx_media_unsized", false, "sent", "sized = FALSE");
    app.save(media);
    app.db().newQuery("UPDATE media SET sized = TRUE WHERE source != message").execute();
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("file_dims");
    messages.createRule = (messages.createRule ?? "").replace(` && ${C_NO_DIMS}`, "");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${C_NO_DIMS}`, "");
    app.save(messages);

    const media = app.findCollectionByNameOrId("media");
    media.removeIndex("idx_media_unsized");
    media.fields.removeByName("sized");
    app.save(media);
  },
);
