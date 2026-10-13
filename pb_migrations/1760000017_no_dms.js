/// <reference path="../types/pocketbase.d.ts" />
// "Doesn't take direct messages" (DESIGN.md §16.7): `users.no_dms`. Nobody can open a DM with such a user, they can't
// open one either, and messages in a DM they are in are refused (pb_hooks/lib/dms.js, lib/messages.js). Off by
// default, so existing and new accounts are unchanged. Set for the Telegram bridge's stand-in users; a user may set it
// on their own record (the update rule allows it), which the profile may offer later.

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new BoolField(/** @type {any} */ ({ name: "no_dms" })));
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("no_dms");
    app.save(users);
  },
);
