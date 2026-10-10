/// <reference path="../pb_data/types.d.ts" />
// Server-side hooks (DESIGN.md §5.6). Logic lives in lib/chat.js; handlers can't share top-level scope.

routerUse((e) => {
  require(`${__hooks}/lib/chat.js`).headers(e);
  return e.next();
});

onRecordCreate((e) => {
  require(`${__hooks}/lib/chat.js`).trim(e.record, "name");
  e.next();
}, "users", "rooms");

onRecordUpdate((e) => {
  require(`${__hooks}/lib/chat.js`).trim(e.record, "name");
  e.next();
}, "users");

onRecordUpdate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeRoomUpdate(e);
  e.next();
}, "rooms");

onRecordCreate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeMessageCreate(e);
  e.next();
}, "messages");

onRecordUpdate((e) => {
  require(`${__hooks}/lib/chat.js`).beforeMessageUpdate(e);
  e.next();
}, "messages");
