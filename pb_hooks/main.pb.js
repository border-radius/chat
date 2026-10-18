/// <reference path="../types/pocketbase.d.ts" />
// Server-side hooks (DESIGN.md §5.6, §16, §18, §20, §21, §22, §23, §24, §28; docs/ANDROID.md §8, §9.4). Logic lives in lib/, one module per collection
// or route: PocketBase hook handlers can't see top-level variables, so each handler require()s its module.

onBootstrap((e) => {
  e.next(); // the settings are loaded once bootstrapped
  require(`${__hooks}/lib/http.js`).trustProxy(e.app);
});

routerUse((e) => {
  require(`${__hooks}/lib/http.js`).headers(e);
  return e.next();
});

// Bodies up to 10 attachments of 20 MB (§17.1): replaces PocketBase's default limit (same middleware id); lib/http.js
// keeps the default for everything but a message create.
routerUse($apis.bodyLimit(require(`${__hooks}/lib/http.js`).MESSAGE_BODY_LIMIT));
routerUse((e) => {
  require(`${__hooks}/lib/http.js`).bodyLimit(e);
  return e.next();
});

// Not the app's index.html (PocketBase's fallback for any other path, §7.1) for a missing asset or API.
routerAdd("GET", "/assets/{path...}", (e) => require(`${__hooks}/lib/http.js`).asset(e));
routerAdd("GET", "/manifest.webmanifest", (e) => require(`${__hooks}/lib/site.js`).manifest(e));
routerAdd("GET", "/.well-known/assetlinks.json", (e) => require(`${__hooks}/lib/push.js`).assetLinks(e));
routerAdd("GET", "/api/{path...}", () => {
  throw new NotFoundError();
});
routerAdd("POST", "/api/previews/tick", (e) => require(`${__hooks}/lib/previews.js`).tick(e), $apis.requireSuperuserAuth());
routerAdd("POST", "/api/push/tick", (e) => require(`${__hooks}/lib/push.js`).tick(e), $apis.requireSuperuserAuth());
routerAdd("POST", "/api/chat/dms", (e) => require(`${__hooks}/lib/dms.js`).openDm(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/unread", (e) => require(`${__hooks}/lib/reads.js`).unread(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/unread/{room}", (e) => require(`${__hooks}/lib/reads.js`).firstUnread(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/reads", (e) => require(`${__hooks}/lib/reads.js`).markRead(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/reactions", (e) => require(`${__hooks}/lib/reactions.js`).react(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/delete", (e) => require(`${__hooks}/lib/bulk.js`).deleteMessages(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/forward", (e) => require(`${__hooks}/lib/bulk.js`).forward(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/users", (e) => require(`${__hooks}/lib/users.js`).searchUsers(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/password", (e) => require(`${__hooks}/lib/account.js`).changePassword(e), $apis.requireAuth("users"));

onRecordCreate((e) => {
  require(`${__hooks}/lib/users.js`).beforeUserSave(e);
  e.next();
}, "users");

onRecordUpdate((e) => {
  require(`${__hooks}/lib/users.js`).beforeUserSave(e);
  e.next();
}, "users");

onRecordDelete((e) => {
  require(`${__hooks}/lib/messages.js`).beforeUserDelete(e);
  e.next();
}, "users");

onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/site.js`).checkInvite(e);
  e.next();
}, "users");

onRecordAuthWithOAuth2Request((e) => {
  require(`${__hooks}/lib/site.js`).checkOAuth2Signup(e);
  e.next();
}, "users");

onRecordAuthWithPasswordRequest((e) => {
  require(`${__hooks}/lib/users.js`).findLoginByEmail(e);
  e.next();
}, "users");

onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/rooms.js`).beforeRoomCreateRequest(e);
  e.next();
}, "rooms");

onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/rooms.js`).beforeRoomUpdateRequest(e);
  e.next();
}, "rooms");

onRecordCreate((e) => {
  require(`${__hooks}/lib/rooms.js`).beforeRoomCreate(e);
  e.next();
}, "rooms");

onRecordUpdate((e) => {
  require(`${__hooks}/lib/rooms.js`).beforeRoomUpdate(e);
  const access = require(`${__hooks}/lib/access.js`);
  const before = access.accessOf(e.record?.original() ?? e.record);
  e.next();
  // Saved: whoever can't see it any more is told (§23.4).
  if (e.record) access.dropLostAccess(e.app, before, e.record);
}, "rooms");

onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/messages.js`).beforeMessageCreateRequest(e);
  e.next();
}, "messages");

onRecordCreate((e) => {
  const messages = require(`${__hooks}/lib/messages.js`);
  messages.beforeMessageCreate(e);
  if (e.record) messages.setTextKey(e.record);
  e.next();
  if (e.record) require(`${__hooks}/lib/previews.js`).queue(e.app, e.record);
  if (e.record) require(`${__hooks}/lib/push.js`).queue(e.app, e.record);
}, "messages");

onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/push.js`).beforeTokenCreate(e);
  e.next();
}, "push_tokens");

onRecordAfterCreateSuccess((e) => {
  require(`${__hooks}/lib/messages.js`).afterMessageCreate(e);
  e.next();
}, "messages");

onRecordUpdate((e) => {
  const messages = require(`${__hooks}/lib/messages.js`);
  messages.beforeMessageUpdate(e);
  if (e.record) messages.setTextKey(e.record);
  const touch = !!e.record && messages.changesForwards(e.record);
  const edited = !!e.record && e.record.getString("text") !== e.record.original().getString("text");
  e.next();
  // Saved: forwards of it tell their readers (§21.3).
  if (touch && e.record) messages.touchForwards(e.app, e.record);
  if (edited && e.record) require(`${__hooks}/lib/previews.js`).queue(e.app, e.record);
}, "messages");

onRecordEnrich((e) => {
  const messages = require(`${__hooks}/lib/messages.js`);
  messages.keepToRoom(e);
  messages.showOriginal(e);
  e.next();
}, "messages");

onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/messages.js`).beforeMessageUpdateRequest(e);
  // One transaction for the save, so beforeMessageUpdate reads the reactions it keeps right before writing (§20.2).
  e.app.runInTransaction((tx) => {
    e.app = tx;
    e.next();
  });
}, "messages");

// Link previews (§28): fetched by a worker, a minute's run at a time.
if (require(`${__hooks}/lib/previews.js`).enabled()) {
  cronAdd("previews", "* * * * *", () => require(`${__hooks}/lib/previews.js`).run($app));
}

// Push notifications for the Android app (docs/ANDROID.md §8): sent by a worker, a minute's run at a time. PUSH_CRON=off
// leaves them to POST /api/push/tick (tests, which decide when a push goes).
if (require(`${__hooks}/lib/push.js`).enabled() && $os.getenv("PUSH_CRON").trim().toLowerCase() !== "off") {
  cronAdd("push", "* * * * *", () => require(`${__hooks}/lib/push.js`).run($app));
}
