/// <reference path="../types/pocketbase.d.ts" />
// Service messages (DESIGN.md §5.3): a message without an author is the app's own notice in a room ("Telegram group
// … was disconnected"), made only by server code (lib/messages.js postService). The create rule still requires
// `author = @request.auth.id` and a signed-in caller, so no request can make one, and no update rule matches one.
// Deleting a user would now clear `author` on their messages rather than fail: a users delete hook
// (lib/messages.js beforeUserDelete) refuses it while they have any, as the required relation did.
// Going down drops them, since `author` is required again.

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    /** @type {any} */ (messages.fields.getByName("author")).required = false;
    app.save(messages);
  },
  (app) => {
    for (const rec of app.findRecordsByFilter("messages", "author = ''", "", 0, 0)) if (rec) app.delete(rec);
    const messages = app.findCollectionByNameOrId("messages");
    /** @type {any} */ (messages.fields.getByName("author")).required = true;
    app.save(messages);
  },
);
