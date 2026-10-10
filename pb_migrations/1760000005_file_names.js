/// <reference path="../types/pocketbase.d.ts" />
// QA BUG-28: keep attachments' original names. `messages.file_names` maps stored name → original name; only the
// create hook writes it (from the upload itself), so clients can't forge it.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new JSONField({ name: "file_names", maxSize: 4096 }));
    app.save(messages);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("file_names");
    app.save(messages);
  },
);
