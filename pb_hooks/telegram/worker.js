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
/** A lock not renewed for this long was left by a run that died. Renewed after every item a pass handles. */
const STALE_MS = 90_000;
/**
 * A queue row being sent is claimed (locked_until) for this long: no other pass sends it meanwhile, even one that took
 * over the lock while this one was stuck on a slow upload (QA BUG-147). A row left claimed by a run that died is sent
 * once it runs out.
 */
const CLAIM_MS = 10 * 60_000;
/** How many times a send that failed for now is tried before it is dropped. */
const MAX_TRIES = 8;
/** Queue rows looked at in one pass. */
const BATCH = 50;

/**
 * Take the worker lock, unless another run holds it. Returns the run's handle on it ("" when not taken): `beat` renews
 * it, `unlock` lets it go, each only while it is still this run's. One taken over as stale (a pass that took too long)
 * is then the new run's: the old one stops at its next beat, and its unlock leaves the new run's lock alone (QA BUG-147).
 * @param {core.App} app
 */
function lock(app) {
  const me = $security.randomString(12);
  let mine = false;
  app.store().setFunc(LOCK, (old) => {
    if (old && Date.now() - Number(String(old).split(" ")[1]) < STALE_MS) return old;
    mine = true;
    return `${me} ${Date.now()}`;
  });
  return mine ? me : "";
}

/**
 * Renew the lock of run `me`. False when it isn't its lock any more (another run took it over).
 * @param {core.App} app
 * @param {string} me
 */
function beat(app, me) {
  let mine = false;
  app.store().setFunc(LOCK, (old) => {
    if (String(old || "").split(" ")[0] !== me) return old;
    mine = true;
    return `${me} ${Date.now()}`;
  });
  return mine;
}

/** @param {core.App} app @param {string} me */
function unlock(app, me) {
  app.store().setFunc(LOCK, (old) => (String(old || "").split(" ")[0] === me ? undefined : old));
}

/** Thrown out of a pass whose run lost the lock: it stops there. */
const LOST = "telegram: lock lost";

/**
 * Claim queue row `id` for sending (locked_until), unless another pass has it. In a transaction: PocketBase's writes
 * go one at a time, so two passes can't both claim it.
 * @param {core.App} app
 * @param {string} id
 */
function claim(app, id) {
  let mine = false;
  app.runInTransaction((tx) => {
    let row;
    try {
      row = tx.findRecordById("tg_queue", id);
    } catch {
      return; // done by another pass
    }
    const until = row.getDateTime("locked_until");
    if (!until.isZero() && until.time().unixMilli() > Date.now()) return;
    row.set("locked_until", new DateTime(new Date(Date.now() + CLAIM_MS).toISOString()));
    tx.save(row);
    mine = true;
  });
  return mine;
}

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
 * Send what is queued for Telegram, oldest first. A group whose oldest item has to wait (a failure that may pass, or
 * another pass sending it) gets nothing more this pass, so its messages arrive in order. `renew` after each one.
 * @param {core.App} app
 * @param {() => void} renew
 */
function drain(app, renew) {
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
    if (!claim(app, row.id)) {
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
      row.set("locked_until", "");
      row.set("error", String(err).slice(0, 1000));
      app.save(row);
      blocked.add(chat);
    } finally {
      renew();
    }
  }
}

/**
 * One pass: poll (when polling), bring over complete albums, send what is queued. Run `me`'s lock is renewed after
 * each item; the pass stops (throws LOST) once it isn't this run's any more.
 * @param {core.App} app
 * @param {number} pollTimeout seconds
 * @param {string} me
 */
function pass(app, pollTimeout, me) {
  const renew = () => {
    if (!beat(app, me)) throw new Error(LOST);
  };
  if (!config().webhookUrl) {
    try {
      poll(app, pollTimeout);
    } catch (err) {
      app.logger().warn("telegram: getUpdates", "error", String(err));
      sleep(1000);
    }
  }
  flushAlbums(app, undefined, undefined, renew);
  drain(app, renew);
}

/**
 * The cron job: passes until the minute is nearly over.
 * @param {core.App} app
 */
function run(app) {
  const me = lock(app);
  if (!me) return;
  try {
    const until = Date.now() + RUN_MS;
    while (Date.now() < until) {
      try {
        pass(app, 1, me);
      } catch (err) {
        if (String(err).includes(LOST)) return app.logger().warn("telegram: worker took too long, another run took over");
        app.logger().error("telegram: worker", "error", String(err));
      }
      if (config().webhookUrl) sleep(1000);
      if (!beat(app, me)) return;
    }
  } finally {
    unlock(app, me);
  }
}

/**
 * POST /api/telegram/tick (superusers): one pass now, unless a run is going (it does the work within a second).
 * @param {core.RequestEvent} e
 */
function tick(e) {
  const me = lock(e.app);
  if (!me) return e.json(202, { ran: false });
  try {
    pass(e.app, 0, me);
  } finally {
    unlock(e.app, me);
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
