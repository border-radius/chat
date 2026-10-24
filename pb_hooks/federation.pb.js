/// <reference path="../types/pocketbase.d.ts" />
// Linked instances (DESIGN.md §33): rooms and DMs shared with other servers running this app, paired by their admins.
// Self-contained like the Telegram bridge: this file, federation/ and the fed_* collections (pb_migrations/
// 1760000032_federation.js); the core only has the fields that migration adds. Without FEDERATION_ORIGIN it registers
// nothing.
//
// Its hooks wrap the core ones (files load by name, and this one comes first): they read a record as it was, let the
// save go on (e.next), then queue what a peer needs to hear, in the save's transaction.

if ($os.getenv("FEDERATION_ORIGIN").trim()) {
  routerAdd("POST", "/api/fed/pair", (e) => require(`${__hooks}/federation/peers.js`).pair(e));
  routerAdd("POST", "/api/fed/inbox", (e) => require(`${__hooks}/federation/inbox.js`).inbox(e));
  routerAdd("GET", "/api/fed/files/{message}/{file}", (e) => require(`${__hooks}/federation/inbox.js`).file(e));
  routerAdd("GET", "/api/fed/avatars/{user}", (e) => require(`${__hooks}/federation/inbox.js`).avatar(e));
  routerAdd("GET", "/api/fed/users", (e) => require(`${__hooks}/federation/inbox.js`).lookup(e));
  routerAdd("POST", "/api/fed/tick", (e) => require(`${__hooks}/federation/worker.js`).tick(e), $apis.requireSuperuserAuth());
  routerAdd("POST", "/api/chat/remote-users", (e) => require(`${__hooks}/federation/inbox.js`).remoteUser(e), $apis.requireAuth("users"));

  cronAdd("federation", "* * * * *", () => require(`${__hooks}/federation/worker.js`).run($app));

  // Pairing (§33.3): superusers, in the admin UI.
  onRecordCreateRequest((e) => {
    require(`${__hooks}/federation/peers.js`).beforePeerCreate(e);
    e.next();
  }, "fed_peers");

  onRecordUpdateRequest((e) => {
    const peers = require(`${__hooks}/federation/peers.js`);
    const changed = peers.beforePeerEdit(e);
    e.next();
    if (e.record) peers.afterPeerEdit(e.app, e.record, changed);
  }, "fed_peers");

  onRecordDeleteRequest((e) => {
    if (e.record) require(`${__hooks}/federation/peers.js`).beforePeerDelete(e.app, e.record);
    e.next();
  }, "fed_peers");

  // Sharing rooms (§33.5): superusers on both sides, in the admin UI.
  onRecordCreateRequest((e) => {
    const rooms = require(`${__hooks}/federation/rooms.js`);
    rooms.beforeOffer(e);
    e.next();
    if (e.record) rooms.afterOffer(e.app, e.record);
  }, "fed_shares");

  onRecordUpdateRequest((e) => {
    const rooms = require(`${__hooks}/federation/rooms.js`);
    const what = rooms.beforeShareEdit(e);
    e.next();
    if (e.record) rooms.afterShareEdit(e.app, e.record, what);
  }, "fed_shares");

  onRecordDeleteRequest((e) => {
    if (e.record) require(`${__hooks}/federation/rooms.js`).beforeShareDelete(e.app, e.record);
    e.next();
  }, "fed_shares");

  // Rooms: a home room's changes go to its mirrors; a DM opened with someone on a peer is shared with it.
  onRecordCreate((e) => {
    e.next();
    if (e.record) require(`${__hooks}/federation/rooms.js`).roomCreated(e.app, e.record);
  }, "rooms");

  onRecordUpdate((e) => {
    const rooms = require(`${__hooks}/federation/rooms.js`);
    const before = e.record ? rooms.stateOf(e.record.original()) : "";
    e.next();
    if (e.record) rooms.roomChanged(e.app, e.record, before);
  }, "rooms");

  onRecordUpdateRequest((e) => {
    const rooms = require(`${__hooks}/federation/rooms.js`);
    rooms.checkHomeMembers(e);
    const change = rooms.checkMirrorEdit(e);
    e.next();
    if (change && e.record) rooms.sendMembers(e.app, e.record, change);
  }, "rooms");

  onRecordDelete((e) => {
    const rooms = require(`${__hooks}/federation/rooms.js`);
    const room = e.record;
    const peers = room ? rooms.peersToTell(e.app, room) : [];
    e.next();
    if (room) rooms.tellDeleted(e.app, room, peers);
  }, "rooms");

  // People: names ending in a peer's label are its people's; a changed profile goes to the peers that know it.
  onRecordCreateRequest((e) => {
    require(`${__hooks}/federation/people.js`).refuseLabelName(e);
    e.next();
  }, "users");

  onRecordUpdateRequest((e) => {
    require(`${__hooks}/federation/people.js`).refuseLabelName(e);
    e.next();
  }, "users");

  onRecordUpdate((e) => {
    const people = require(`${__hooks}/federation/people.js`);
    const before = e.record ? people.profileKey(e.record.original()) : "";
    e.next();
    if (e.record) people.userChanged(e.app, e.record, before);
  }, "users");

  // Messages in shared rooms (§33.5).
  onRecordCreate((e) => {
    e.next();
    if (e.record) require(`${__hooks}/federation/messages.js`).messageCreated(e.app, e.record);
  }, "messages");

  onRecordUpdate((e) => {
    const messages = require(`${__hooks}/federation/messages.js`);
    const was = e.record ? messages.before(e.record) : null;
    if (e.record) messages.checkMirrorChange(e.app, e.record);
    e.next();
    if (e.record && was) messages.messageChanged(e.app, e.record, was);
  }, "messages");
}
