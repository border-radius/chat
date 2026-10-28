/// <reference path="../types/pocketbase.d.ts" />
// Telegram bridge (DESIGN.md §26): messages go both ways between rooms and the Telegram groups they are linked to.
// This file, telegram/ and the tg_* collections (pb_migrations/1760000019_telegram.js); what it does on the core
// collections' saves (messages, users) main.pb.js calls through lib/features.js, which is off without
// TELEGRAM_BOT_TOKEN. Without it this file registers nothing either.

if ($os.getenv("TELEGRAM_BOT_TOKEN").trim()) {
  // Only when serving: other commands (migrate, superuser…) bootstrap too.
  onBootstrap((e) => {
    e.next();
    if ($os.args.includes("serve")) require(`${__hooks}/telegram/worker.js`).setup(e.app);
  });

  routerAdd("POST", "/api/telegram/webhook", (e) => require(`${__hooks}/telegram/inbound.js`).webhook(e));
  routerAdd("POST", "/api/telegram/tick", (e) => require(`${__hooks}/telegram/worker.js`).tick(e), $apis.requireSuperuserAuth());

  cronAdd("telegram", "* * * * *", () => require(`${__hooks}/telegram/worker.js`).run($app));

  // A room says when a group is connected to it or disconnected from it (a service message, §26.5).
  onRecordCreate((e) => {
    const links = require(`${__hooks}/telegram/links.js`);
    links.beforeLinkSave(e);
    e.next();
    if (e.record) links.tellLinkChange(e.app, e.record, "", links.linkedRoom(e.record));
  }, "tg_links");

  onRecordUpdate((e) => {
    const links = require(`${__hooks}/telegram/links.js`);
    links.beforeLinkSave(e);
    const rec = e.record;
    if (!rec) return e.next();
    // What it was, as stored, read in the save's transaction: the same change saved twice at once tells the room once.
    e.app.runInTransaction((tx) => {
      e.app = tx;
      const was = links.linkedRoom(tx.findRecordById("tg_links", rec.id));
      e.next();
      links.tellLinkChange(tx, rec, was, links.linkedRoom(rec));
    });
  }, "tg_links");

  onRecordAfterDeleteSuccess((e) => {
    const links = require(`${__hooks}/telegram/links.js`);
    // Deleted with its room (cascade), there's no room left to tell.
    if (e.record) links.tellLinkChange(e.app, e.record, links.linkedRoom(e.record), "");
    e.next();
  }, "tg_links");
}
