/// <reference path="../types/pocketbase.d.ts" />
// Server-side hooks (DESIGN.md §5.6, §16, §18). Logic lives in lib/; handlers can't share top-level scope.

routerUse((e) => {
  require(`${__hooks}/lib/chat.js`).headers(e);
  return e.next();
});

routerAdd("POST", "/api/chat/dms", (e) => require(`${__hooks}/lib/dms.js`).openDm(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/unread", (e) => require(`${__hooks}/lib/reads.js`).unread(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/reads", (e) => require(`${__hooks}/lib/reads.js`).markRead(e), $apis.requireAuth("users"));

onRecordCreate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeUserSave(e);
  e.next();
}, "users");

onRecordUpdate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeUserSave(e);
  e.next();
}, "users");

onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/chat.js`).beforeRoomCreateRequest(e);
  e.next();
}, "rooms");

onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/chat.js`).beforeRoomUpdateRequest(e);
  e.next();
}, "rooms");

onRecordCreate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeRoomCreate(e);
  e.next();
}, "rooms");

onRecordUpdate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeRoomUpdate(e);
  e.next();
}, "rooms");

onRecordCreate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeMessageCreate(e);
  e.next();
}, "messages");

onRecordAfterCreateSuccess((e) => {
  require(`${__hooks}/lib/chat.js`).afterMessageCreate(e);
  e.next();
}, "messages");

onRecordUpdate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeMessageUpdate(e);
  e.next();
}, "messages");
