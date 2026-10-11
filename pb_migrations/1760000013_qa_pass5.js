/// <reference path="../types/pocketbase.d.ts" />
// Fixes from the fifth QA pass (docs/QA.md):
// - BUG-53: a password only changes through POST /api/chat/password (§22.2), which is rate limited and checks the new
//   one. PocketBase's own users update also accepted { oldPassword, password, passwordConfirm }, at the generic limit.

const NO_PASSWORD = "@request.body.password:isset = false && @request.body.passwordConfirm:isset = false";

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.updateRule = `${users.updateRule} && ${NO_PASSWORD}`;
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.updateRule = (users.updateRule ?? "").replace(` && ${NO_PASSWORD}`, "");
    app.save(users);
  },
);
