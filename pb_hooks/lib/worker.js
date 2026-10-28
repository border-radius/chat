/// <reference path="../../types/pocketbase.d.ts" />
// The cron workers' run loop (link previews §28, media §30.1, Telegram §26.7, federation §33.8): a cron job starts a
// run every minute and it goes on for most of that minute, a pass at a time. One run at a time, by a lock in the app
// store holding the run's own handle and when it was last renewed. A lock not renewed for `staleMs` was left by a run
// that died (or is stuck) and is taken over; the old run then stops at its next renew, and its unlock leaves the new
// run's lock alone (QA BUG-147). Passes renew after every item they handle (`renew`), so a slow item can't make the
// lock look stale while it is still being worked on (QA BUG-111).

/** How long one run goes on: the next one starts on the next minute. */
const RUN_MS = 57_000;
/** Thrown by `renew` once the lock is another run's: the pass stops there. */
const LOST = "worker: lock lost";

/** @param {unknown} err */
const isLost = (err) => String(err).includes(LOST);

/**
 * Take lock `name`, unless a run holds it. Returns the run's handle ("" when not taken).
 * @param {core.App} app
 * @param {string} name
 * @param {number} staleMs
 */
function lock(app, name, staleMs) {
  const me = $security.randomString(12);
  let mine = false;
  app.store().setFunc(name, (old) => {
    if (old && Date.now() - Number(String(old).split(" ")[1]) < staleMs) return old;
    mine = true;
    return `${me} ${Date.now()}`;
  });
  return mine ? me : "";
}

/**
 * Renew run `me`'s lock. False when it isn't its lock any more.
 * @param {core.App} app
 * @param {string} name
 * @param {string} me
 */
function beat(app, name, me) {
  let mine = false;
  app.store().setFunc(name, (old) => {
    if (String(old || "").split(" ")[0] !== me) return old;
    mine = true;
    return `${me} ${Date.now()}`;
  });
  return mine;
}

/** @param {core.App} app @param {string} name @param {string} me */
function unlock(app, name, me) {
  app.store().setFunc(name, (old) => (String(old || "").split(" ")[0] === me ? undefined : old));
}

/**
 * @typedef {object} Worker
 * @property {string} name the lock's key in the app store, e.g. "media.worker"
 * @property {string} label how its log lines start, e.g. "media"
 * @property {number} staleMs
 * @property {(renew: () => void) => unknown} pass one pass; call `renew` after each item. Truthy: there may be more
 *   to do now, so the next pass goes at once; otherwise the run waits a second first.
 */

/**
 * The cron job: passes until the minute is nearly over.
 * @param {core.App} app
 * @param {Worker} w
 */
function run(app, w) {
  const me = lock(app, w.name, w.staleMs);
  if (!me) return;
  const renew = () => {
    if (!beat(app, w.name, me)) throw new Error(LOST);
  };
  try {
    const until = Date.now() + RUN_MS;
    while (Date.now() < until) {
      let busy = false;
      try {
        busy = !!w.pass(renew);
      } catch (err) {
        if (isLost(err)) return app.logger().warn(`${w.label}: worker took too long, another run took over`);
        app.logger().error(`${w.label}: worker`, "error", String(err));
      }
      if (!busy) sleep(1000);
      if (!beat(app, w.name, me)) return;
    }
  } finally {
    unlock(app, w.name, me);
  }
}

/**
 * One pass now, holding the lock (a tick route), unless a run holds it: it does the work within a second. Returns
 * whether it ran.
 * @param {core.App} app
 * @param {Worker} w
 */
function once(app, w) {
  const me = lock(app, w.name, w.staleMs);
  if (!me) return false;
  try {
    w.pass(() => {
      if (!beat(app, w.name, me)) throw new Error(LOST);
    });
  } finally {
    unlock(app, w.name, me);
  }
  return true;
}

module.exports = { run, once, isLost, lock, beat, unlock };
