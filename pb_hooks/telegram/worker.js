/// <reference path="../../types/pocketbase.d.ts" />
// The bridge's worker (DESIGN.md §26.7). A cron job starts it every minute and it runs for most of that minute,
// once a second: it brings over albums that are complete and sends what is queued for Telegram, oldest first. In
// development (no webhook URL) it also polls Telegram for updates. One runs at a time (a lock in the app store);
// POST /api/telegram/tick runs one pass at once (tests, or an admin who doesn't want to wait).

const { asTelegram, call, config, UPDATES } = require(`${__hooks}/telegram/api.js`);
const { flushAlbums, handleUpdate } = require(`${__hooks}/telegram/inbound.js`);
const { edit, remove, send } = require(`${__hooks}/telegram/outbound.js`);

const LOCK = "telegram.worker";
const OFFSET = "telegram.offset";
/** How long one run goes on: the next one starts on the next minute. */
const RUN_MS = 57_000;
/** A lock older than this was left by a run that died. */
const STALE_MS = 90_000;
/** How many times a send that failed for now is tried before it is dropped. */
const MAX_TRIES = 8;
/** Queue rows looked at in one pass. */
const BATCH = 50;

/**
 * Take the worker lock, unless another run holds it.
 * @param {core.App} app
 */
function lock(app) {
  let mine = false;
  app.store().setFunc(LOCK, (old) => {
    if (old && Date.now() - Number(old) < STALE_MS) return old;
    mine = true;
    return Date.now();
  });
  return mine;
}

/** @param {core.App} app */
const unlock = (app) => app.store().remove(LOCK);

/**
 * Updates from Telegram, when polling (no webhook URL), waiting at most `timeout` seconds for one.
 * @param {core.App} app
 * @param {number} timeout
 */
function poll(app, timeout) {
  const offset = Number(app.store().get(OFFSET) || 0);
  const updates = call("getUpdates", { offset, timeout, allowed_updates: UPDATES }, undefined, timeout + 10) || [];
  for (const u of updates) {
    app.store().set(OFFSET, u.update_id + 1);
    try {
      handleUpdate(app, u);
    } catch (err) {
      app.logger().error("telegram: update", "update", u.update_id, "error", String(err));
    }
  }
}

/**
 * Send what is queued for Telegram, oldest first. A group whose oldest item has to wait (a failure that may pass)
 * gets nothing more this pass, so its messages arrive in order.
 * @param {core.App} app
 */
function drain(app) {
  const rows = app.findRecordsByFilter("tg_queue", "op != 'album'", "created,id", BATCH, 0);
  const blocked = new Set();
  const now = Date.now();
  for (const row of rows) {
    if (!row) continue;
    const chat = row.getString("chat_id");
    if (blocked.has(chat)) continue;
    const due = row.getDateTime("next_at");
    if (!due.isZero() && due.time().unixMilli() > now) {
      blocked.add(chat);
      continue;
    }
    const op = row.getString("op");
    const message = row.getString("message");
    try {
      if (op === "send") send(app, message, chat);
      else if (op === "edit") edit(app, message, chat);
      else if (op === "delete") remove(app, message, chat);
      app.delete(row);
    } catch (err) {
      const tries = row.getInt("tries") + 1;
      const tg = asTelegram(err);
      const transient = !tg || tg.transient;
      app.logger().warn(`telegram: ${op}`, "message", message, "chat", chat, "try", tries, "error", String(err));
      if (!transient || tries >= MAX_TRIES) {
        app.delete(row);
        continue;
      }
      const wait = Math.max(tg ? tg.retryAfter : 0, 2 ** tries) * 1000;
      row.set("tries", tries);
      row.set("next_at", new DateTime(new Date(Date.now() + wait).toISOString()));
      row.set("error", String(err).slice(0, 1000));
      app.save(row);
      blocked.add(chat);
    }
  }
}

/**
 * One pass: poll (when polling), bring over complete albums, send what is queued.
 * @param {core.App} app
 * @param {number} pollTimeout seconds
 */
function pass(app, pollTimeout) {
  if (!config().webhookUrl) {
    try {
      poll(app, pollTimeout);
    } catch (err) {
      app.logger().warn("telegram: getUpdates", "error", String(err));
      sleep(1000);
    }
  }
  flushAlbums(app);
  drain(app);
}

/**
 * The cron job: passes until the minute is nearly over.
 * @param {core.App} app
 */
function run(app) {
  if (!lock(app)) return;
  try {
    const until = Date.now() + RUN_MS;
    while (Date.now() < until) {
      try {
        pass(app, 1);
      } catch (err) {
        app.logger().error("telegram: worker", "error", String(err));
      }
      if (config().webhookUrl) sleep(1000);
      app.store().set(LOCK, Date.now());
    }
  } finally {
    unlock(app);
  }
}

/**
 * POST /api/telegram/tick (superusers): one pass now, unless a run is going (it does the work within a second).
 * @param {core.RequestEvent} e
 */
function tick(e) {
  if (!lock(e.app)) return e.json(202, { ran: false });
  try {
    pass(e.app, 0);
  } finally {
    unlock(e.app);
  }
  return e.json(200, { ran: true });
}

/**
 * On start: tell Telegram where to send updates (one at a time, so they arrive in order), or, without a webhook
 * URL, that the bridge polls.
 * @param {core.App} app
 */
function setup(app) {
  const { webhookUrl, secret } = config();
  try {
    if (webhookUrl) call("setWebhook", { url: webhookUrl, secret_token: secret, allowed_updates: UPDATES, max_connections: 1 });
    else call("deleteWebhook", {});
  } catch (err) {
    app.logger().error("telegram: setup", "error", String(err));
  }
}

module.exports = { run, tick, setup };
