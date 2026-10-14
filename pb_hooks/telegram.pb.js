/// <reference path="../types/pocketbase.d.ts" />
// Telegram bridge (DESIGN.md §26): messages go both ways between rooms and the Telegram groups they are linked to.
// Self-contained: this file, telegram/ and the tg_* collections (pb_migrations/1760000019_telegram.js); nothing else
// knows about it. Without TELEGRAM_BOT_TOKEN it registers nothing. To remove it, delete this file and telegram/.

if ($os.getenv("TELEGRAM_BOT_TOKEN").trim()) {
  // Only when serving: other commands (migrate, superuser…) bootstrap too.
  onBootstrap((e) => {
    e.next();
    if ($os.args.includes("serve")) require(`${__hooks}/telegram/worker.js`).setup(e.app);
  });

  routerAdd("POST", "/api/telegram/webhook", (e) => require(`${__hooks}/telegram/inbound.js`).webhook(e));
  routerAdd("POST", "/api/telegram/tick", (e) => require(`${__hooks}/telegram/worker.js`).tick(e), $apis.requireSuperuserAuth());

  cronAdd("telegram", "* * * * *", () => require(`${__hooks}/telegram/worker.js`).run($app));

  onRecordCreate((e) => {
    e.next();
    if (e.record) require(`${__hooks}/telegram/outbound.js`).queueCreate(e.app, e.record);
  }, "messages");

  onRecordUpdate((e) => {
    const outbound = require(`${__hooks}/telegram/outbound.js`);
    const change = e.record ? outbound.changeOf(e.record) : "";
    e.next();
    if (e.record) outbound.queueUpdate(e.app, e.record, change);
  }, "messages");

  onRecordCreateRequest((e) => {
    require(`${__hooks}/telegram/people.js`).refuseStandInName(e);
    e.next();
  }, "users");

  onRecordUpdateRequest((e) => {
    require(`${__hooks}/telegram/people.js`).refuseStandInName(e);
    e.next();
  }, "users");

  onRecordCreate((e) => {
    require(`${__hooks}/telegram/links.js`).beforeLinkSave(e);
    e.next();
  }, "tg_links");

  onRecordUpdate((e) => {
    require(`${__hooks}/telegram/links.js`).beforeLinkSave(e);
    e.next();
  }, "tg_links");
}
