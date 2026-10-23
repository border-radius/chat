/// <reference path="../../types/pocketbase.d.ts" />
// Push notifications for the Android app (docs/ANDROID.md §8). A new message is queued (push_queue, in the save's
// transaction); a worker started by a cron job, one run at a time, sends each one to the devices of everyone who can
// see its room (lib/access.js), but not to its author, not to those who hid the room, and not to those who have read
// past it. The payload is ids only (room, message, kind): the app fetches the message with its own session, so its
// text never passes through Google.
//
// - FCM: on with FCM_SERVICE_ACCOUNT (the service account's JSON). FCM_ENDPOINT replaces https://fcm.googleapis.com
//   (tests). A token FCM no longer knows is deleted.
// - UnifiedPush: on with UNIFIEDPUSH=on. Its tokens are endpoint URLs, POSTed to directly, only on public addresses (the
//   link previews' rules, §28.1, checked again when sending, and sent with their curl: no redirects followed; hosts in
//   PUSH_ALLOW_HOSTS are let through, for tests). A 404 or 410 deletes it.
// Without either, nothing is queued.

const { SEES_SQL } = require(`${__hooks}/lib/access.js`);

const LOCK = "push.worker";
const RUN_MS = 57_000;
const STALE_MS = 120_000;
const BATCH = 20;
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** A push older than this is of no use any more: FCM drops it rather than deliver it late. */
const TTL_S = 24 * 3600;

/** The FCM service account, parsed, or null. */
function fcmAccount() {
  const raw = $os.getenv("FCM_SERVICE_ACCOUNT").trim();
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    return a.client_email && a.private_key && a.project_id ? a : null;
  } catch {
    return null;
  }
}

const unifiedPush = () => $os.getenv("UNIFIEDPUSH").trim().toLowerCase() === "on";
const enabled = () => !!fcmAccount() || unifiedPush();

/** PUSH_ALLOW_HOSTS: endpoints on these hosts are POSTed to without checks (tests). */
const allowedHosts = () =>
  $os
    .getenv("PUSH_ALLOW_HOSTS")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

/**
 * May the server POST to this UnifiedPush endpoint? https (or an allowed test host) on a public address.
 * @param {string} url
 */
function endpointAllowed(url) {
  const m = /^(https?):\/\/([^/?#@\s]+)/i.exec(url);
  if (!m) return false;
  const host = m[2].toLowerCase();
  if (allowedHosts().includes(host)) return true;
  return m[1].toLowerCase() === "https" && require(`${__hooks}/lib/previews.js`).publicHost(host);
}

// ---------------------------------------------------------------- registering a device

/**
 * push_tokens create request: the token must suit its provider; the same user registering the same token again (the
 * app after a reinstall, or a lost row id) replaces their row. Other users keep theirs: one device can hold several
 * accounts on this server (docs/ANDROID.md §17.4).
 * @param {core.RecordRequestEvent} e
 */
function beforeTokenCreate(e) {
  const rec = e.record;
  if (!rec) return;
  const token = rec.getString("token").trim();
  rec.set("token", token);
  const provider = rec.getString("provider");
  const url = /^https?:\/\//i.test(token);
  if ((provider === "unifiedpush" && !endpointAllowed(token)) || (provider === "fcm" && url)) {
    throw new BadRequestError("Failed to create record.", {
      token: new ValidationError("validation_invalid_token", "This isn't a push token for that provider."),
    });
  }
  const user = rec.getString("user");
  for (const old of e.app.findRecordsByFilter("push_tokens", "token = {:token} && user = {:user}", "", 0, 0, { token, user })) {
    if (old) e.app.delete(old);
  }
}

// ---------------------------------------------------------------- the queue

/**
 * A message was created: queue its pushes (not a service message's, §5.3). In the save's transaction.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function queue(app, rec) {
  if (!enabled() || !rec.getString("author") || rec.getBool("deleted")) return;
  const row = new Record(app.findCollectionByNameOrId("push_queue"));
  row.set("message", rec.id);
  app.save(row);
}

/**
 * The devices to tell about message `msg` in `room`: everyone who can see the room, but not its author, those who hid
 * it, or those who have read past the message; nobody for an archived room (§13: hidden and archived rooms are silent).
 * @param {core.App} app
 * @param {core.Record} msg
 */
function recipients(app, msg) {
  const rows = arrayOf(new DynamicModel({ id: "", user: "", token: "", provider: "" }));
  app
    .db()
    .newQuery(
      `SELECT pt.id AS id, pt.user AS user, pt.token AS token, pt.provider AS provider
       FROM push_tokens pt JOIN rooms r ON r.id = {:room}
       WHERE r.archived = FALSE AND pt.user != {:author}
         AND ${SEES_SQL.split("{:me}").join("pt.user")}
         AND NOT EXISTS (SELECT 1 FROM hidden_rooms h WHERE h.user = pt.user AND h.room = r.id)
         AND NOT EXISTS (SELECT 1 FROM room_reads rr WHERE rr.user = pt.user AND rr.room = r.id AND rr.last_read_at >= {:created})`,
    )
    .bind({ room: msg.getString("room"), author: msg.getString("author"), created: msg.getString("created") })
    .all(rows);
  return /** @type {{ id: string, user: string, token: string, provider: string }[]} */ (/** @type {unknown} */ (rows));
}

/** @param {core.App} app @param {string} id */
function dropToken(app, id) {
  try {
    app.delete(app.findRecordById("push_tokens", id));
  } catch {
    // already gone
  }
}

/**
 * Send to one FCM token. Returns false when the token is dead (it is then deleted).
 * @param {core.App} app
 * @param {{ project_id: string, client_email: string, private_key: string, token_uri?: string }} account
 * @param {{ id: string, token: string }} to
 * @param {Record<string, string>} data
 * @param {boolean} high
 */
function sendFcm(app, account, to, data, high) {
  const base = ($os.getenv("FCM_ENDPOINT").trim() || "https://fcm.googleapis.com").replace(/\/+$/, "");
  const body = JSON.stringify({
    message: { token: to.token, data, android: { priority: high ? "HIGH" : "NORMAL", ttl: `${TTL_S}s`, collapse_key: data.room } },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = require(`${__hooks}/lib/google.js`).accessToken(app, account, SCOPE);
    const res = $http.send({
      url: `${base}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      timeout: 15,
    });
    if (res.statusCode === 200) return true;
    if (res.statusCode === 401 && attempt === 0) {
      app.store().remove(`google.token.${account.client_email}.${SCOPE}`); // revoked or expired early: a new one
      continue;
    }
    const code = JSON.stringify(res.json ?? {});
    if (res.statusCode === 404 || code.includes("UNREGISTERED") || (res.statusCode === 400 && code.includes("registration token"))) {
      dropToken(app, to.id);
      return false;
    }
    app.logger().warn("push: fcm", "status", res.statusCode, "answer", code.slice(0, 300));
    return true;
  }
  return true;
}

/**
 * POST to a UnifiedPush endpoint. A 404 or 410 means it is gone (it is then deleted).
 * @param {core.App} app
 * @param {{ id: string, token: string }} to
 * @param {Record<string, string>} data
 * @param {boolean} high
 */
function sendUnifiedPush(app, to, data, high) {
  if (!endpointAllowed(to.token)) return dropToken(app, to.id);
  // With curl, as link previews fetch (QA BUG-141): its name looked up and every address checked public, then connected
  // to that address only, and a redirect not followed. $http.send would follow one inward (to 127.0.0.1, 169.254.…).
  const status = require(`${__hooks}/lib/previews.js`).post(
    to.token,
    { "content-type": "application/json", ttl: String(TTL_S), urgency: high ? "high" : "normal" },
    JSON.stringify(data),
    10,
    allowedHosts(),
  );
  if (status === 404 || status === 410) dropToken(app, to.id);
  else if (status >= 300) app.logger().warn("push: unifiedpush", "status", status);
}

/**
 * The pushes of one queued message.
 * @param {core.App} app
 * @param {string} id
 */
function deliver(app, id) {
  let msg;
  try {
    msg = app.findRecordById("messages", id);
  } catch {
    return; // deleted meanwhile (cascade would have taken the row too)
  }
  if (msg.getBool("deleted")) return;
  let room;
  try {
    room = app.findRecordById("rooms", msg.getString("room"));
  } catch {
    return;
  }
  const high = room.getString("kind") === "dm";
  // `user`: the recipient, so a device with several accounts knows which one to notify (§17.4).
  const ids = { room: room.id, message: msg.id, kind: high ? "dm" : "room" };
  const account = fcmAccount();
  for (const to of recipients(app, msg)) {
    if (!to) continue;
    const data = { ...ids, user: to.user };
    try {
      if (to.provider === "fcm" && account) sendFcm(app, account, to, data, high);
      else if (to.provider === "unifiedpush" && unifiedPush()) sendUnifiedPush(app, to, data, high);
    } catch (err) {
      app.logger().warn("push: send", "provider", to.provider, "error", String(err));
    }
  }
}

/**
 * One pass over the oldest queued messages. `beat` (the worker renewing its lock) after each one.
 * @param {core.App} app
 * @param {() => void} [beat]
 */
function pass(app, beat) {
  const rows = app.findRecordsByFilter("push_queue", "", "created,id", BATCH, 0);
  for (const row of rows) {
    if (!row) continue;
    try {
      deliver(app, row.getString("message"));
    } catch (err) {
      app.logger().warn("push: deliver", "message", row.getString("message"), "error", String(err));
    }
    try {
      app.delete(row);
    } catch {
      // gone with its message
    }
    beat?.();
  }
  return rows.length;
}

/**
 * The cron job: passes, once a second, until the minute is nearly over. One run at a time (as lib/previews.js).
 * @param {core.App} app
 */
function run(app) {
  let mine = false;
  app.store().setFunc(LOCK, (old) => {
    if (old && Date.now() - Number(old) < STALE_MS) return old;
    mine = true;
    return Date.now();
  });
  if (!mine) return;
  const beat = () => app.store().set(LOCK, Date.now());
  try {
    const until = Date.now() + RUN_MS;
    while (Date.now() < until) {
      try {
        if (!pass(app, beat)) sleep(1000);
      } catch (err) {
        app.logger().error("push: worker", "error", String(err));
        sleep(1000);
      }
      beat();
    }
  } finally {
    app.store().remove(LOCK);
  }
}

/**
 * POST /api/push/tick (superusers): send what is queued now.
 * @param {core.RequestEvent} e
 */
function tick(e) {
  while (pass(e.app) === BATCH);
  return e.noContent(204);
}

// ---------------------------------------------------------------- App Links (§9.4)

/**
 * GET /.well-known/assetlinks.json: lets the Android app open links to rooms and messages (§9.4). From ANDROID_APP_ID
 * and ANDROID_CERT_SHA256 (comma-separated fingerprints); 404 without them.
 * @param {core.RequestEvent} e
 */
function assetLinks(e) {
  const app = $os.getenv("ANDROID_APP_ID").trim();
  const certs = $os
    .getenv("ANDROID_CERT_SHA256")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (!app || !certs.length) throw new NotFoundError();
  e.response.header().set("Cache-Control", "public, max-age=3600");
  return e.json(200, [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: app, sha256_cert_fingerprints: certs },
    },
  ]);
}

module.exports = { enabled, queue, recipients, beforeTokenCreate, run, tick, assetLinks, endpointAllowed };
