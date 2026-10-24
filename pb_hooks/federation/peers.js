/// <reference path="../../types/pocketbase.d.ts" />
// Pairing (DESIGN.md §33.3) and unpairing (§33.7), by superusers in the admin UI (Collections → fed_peers).
// - Asking: a row with the other instance's origin and a label. It is saved `invited` with a one-time code, and the
//   code goes to that origin (POST /api/fed/request), so only the instance the admin named learns it.
// - Being asked: the other side checks the request by asking back (POST /api/fed/verify on the asking origin), so a
//   request claiming to be from someone else never shows. It then shows as a `requested` row, with a label suggested
//   from the host.
// - Accepting: that row's admin sets it active (and the label as they like). This side makes the secret and sends it
//   with the code to POST /api/fed/pair over https; both rows are then active. Deleting a pending row declines (or
//   withdraws) it, and tells the other side.
// - Both sides asking each other: the second request pairs at once.
// - Suspending (status → suspended) holds everything until it is active again; deleting the row unpairs.

const { fieldError } = require(`${__hooks}/lib/records.js`);
const { allowPrivate, cleanOrigin, enabled, hostOf, isActive, myHost, newId, origin, originProblem, peerByOrigin, peerHost } = require(
  `${__hooks}/federation/config.js`,
);
const { call, errorOf, jsonBody, pairing, target } = require(`${__hooks}/federation/net.js`);
const { refreshDms } = require(`${__hooks}/federation/people.js`);
const { endShare, setDown } = require(`${__hooks}/federation/rooms.js`);

/** How an invited row's `last_error` starts while its request is to be sent again. */
const EXPIRED = "Expired: no answer in 7 days. Delete the row and add it again to ask again.";
const UNREACHED = "Can't be reached yet: ";
/** How long a request may wait for the other side's admin. */
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
/** The most requests waiting here at once: more are refused (429) until some are accepted or declined. */
const MAX_REQUESTED = 20;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const HEX = "0123456789abcdef";
/** Host names' first parts that say nothing about which instance it is: "chat.acme.org" is suggested as "acme". */
const GENERIC = new Set(["chat", "www", "app", "im", "talk", "m", "web"]);

/** @param {core.App} app */
function siteName(app) {
  const found = app.findRecordsByFilter("site", "", "created", 1, 0);
  return found[0]?.getString("title") || "Chat";
}

/** Why this instance can't pair now, or "". */
const offProblem = (/** @type {core.App} */ app) =>
  originProblem() || (enabled(app) ? "" : "Linking is off here: tick `federation` in Collections → site first.");

/**
 * fed_peers create and update requests: a clean origin (not this server's), a label as names show it ("Ann (B)").
 * @param {core.RecordRequestEvent} e
 */
function checkPeer(e) {
  const rec = /** @type {core.Record} */ (e.record);
  const o = cleanOrigin(rec.getString("origin"));
  if (!o) throw fieldError("origin", "The other instance's address, like https://chat.example.org.");
  if (!o.startsWith("https://") && !allowPrivate()) throw fieldError("origin", "Instances are linked over https only.");
  if (hostOf(o) === myHost()) throw fieldError("origin", "That is this instance.");
  rec.set("origin", o);
  const label = rec.getString("label").trim();
  if (!/^[^\s()@]{1,8}$/u.test(label))
    throw fieldError("label", '1 to 8 characters, no spaces or brackets: its people show as "Ann (label)".');
  rec.set("label", label);
}

/**
 * A label for a requested row, until its admin picks one: the host's telling part, cut to 8, made unique.
 * @param {core.App} app
 * @param {string} host
 */
function suggestLabel(app, host) {
  const parts = host.replace(/:\d+$/, "").split(".");
  const part = parts.find((p, i) => i < parts.length - 1 && !GENERIC.has(p)) || parts[0] || "";
  const base = part.replace(/[^a-z0-9_-]/g, "").slice(0, 8) || "peer";
  const taken = (/** @type {string} */ l) => app.findRecordsByFilter("fed_peers", "label = {:l}", "", 1, 0, { l }).length > 0;
  if (!taken(base)) return base;
  for (let n = 2; n < 10; n++) {
    const l = `${base.slice(0, 7)}${n}`;
    if (!taken(l)) return l;
  }
  return $security.randomStringWithAlphabet(6, "abcdefghijkmnpqrstuvwxyz23456789");
}

/**
 * fed_peers create request: ask the other instance to link (§33.3, step 1), before the row is saved, so the admin hears
 * at once if it refuses (it doesn't link, or lists this instance already). One that can't be reached is saved with
 * `last_error` and asked again by the worker. One that asked this instance too pairs at once.
 * @param {core.RecordRequestEvent} e
 */
function beforePeerCreate(e) {
  const off = offProblem(e.app);
  if (off) throw fieldError("origin", off);
  checkPeer(e);
  const rec = /** @type {core.Record} */ (e.record);
  const there = peerByOrigin(e.app, rec.getString("origin"));
  if (there?.getString("status") === "requested")
    throw fieldError("origin", "This instance asked to link already: set its row's status to active to accept.");
  if (there) throw fieldError("origin", "This instance is listed already.");
  rec.set("secret", "");
  rec.set("status", "invited");
  rec.set("invite", $security.randomStringWithAlphabet(32, CODE_ALPHABET));
  rec.set("invite_expires", new DateTime(new Date(Date.now() + INVITE_MS).toISOString()));
  rec.set("name", "");
  rec.set("last_ok", "");
  rec.set("last_error", "");
  const r = ask(e.app, rec);
  if (r.outcome === "refused") throw fieldError("origin", r.error.slice(0, 300));
  noteAsked(e.app, rec, r, "origin");
}

/**
 * The app store key an invited row's code is under while its request is out: the other side checks it by asking back
 * (POST /api/fed/verify) before the row is saved.
 * @param {string} o the asked origin
 */
const ASKING_KEY = (o) => `fed.asking.${o}`;

/**
 * @typedef {{ outcome: "sent" | "retry" | "refused", error: string, name: string, code: string }} Asked
 * code: the other side's own code, when it had asked this instance too.
 */

/**
 * Send an invited row's code to its origin (POST /api/fed/request), which only the instance at that address can read.
 * @param {core.App} app
 * @param {core.Record} rec
 * @returns {Asked}
 */
function ask(app, rec) {
  const o = rec.getString("origin");
  try {
    target(o);
  } catch (err) {
    return { outcome: "refused", error: `That address can't be linked with: ${String(err).slice(0, 200)}`, name: "", code: "" };
  }
  /** @type {ReturnType<typeof pairing>} */
  let answer;
  app.store().set(ASKING_KEY(o), rec.getString("invite"));
  try {
    answer = pairing(o, "/api/fed/request", { origin: origin(), code: rec.getString("invite"), name: siteName(app) });
  } catch (err) {
    return { outcome: "retry", error: `${UNREACHED}${String(err).slice(0, 200)}`, name: "", code: "" };
  } finally {
    app.store().remove(ASKING_KEY(o));
  }
  if (answer.status === 200) {
    const body = jsonBody(answer) || {};
    const code = typeof body.code === "string" && /^[A-Za-z0-9]{32}$/.test(body.code) ? body.code : "";
    return { outcome: "sent", error: "", name: String(body.name || "").slice(0, 255), code };
  }
  if (answer.status >= 500 || answer.status === 429)
    return { outcome: "retry", error: `${UNREACHED}${errorOf(answer)}`, name: "", code: "" };
  const error = answer.status === 404 ? "It doesn't take links (not this app, or linking is off there)." : `It refused: ${errorOf(answer)}`;
  return { outcome: "refused", error, name: "", code: "" };
}

/**
 * Note on an invited row how its request went: `last_ok` once delivered, `last_error` else. When the other side had
 * asked too, pair now with its code.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {Asked} r
 * @param {string} field the field to show a pairing refusal on
 */
function noteAsked(app, rec, r, field) {
  if (r.code) {
    rec.set("invite", r.code);
    pairNow(app, rec, field);
    return;
  }
  if (r.outcome === "sent") {
    rec.set("last_ok", new DateTime());
    rec.set("last_error", "");
    rec.set("name", r.name);
  } else {
    rec.set("last_error", r.error.slice(0, 1000));
  }
}

/**
 * Accept a requested row (§33.3, step 3): make the secret and send it with the asking side's code. Sets the record
 * active; throws when the other side refuses.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {string} field the field to show a refusal on
 */
function pairNow(app, rec, field) {
  const secret = $security.randomStringWithAlphabet(64, HEX);
  /** @type {ReturnType<typeof pairing>} */
  let answer;
  try {
    answer = pairing(rec.getString("origin"), "/api/fed/pair", {
      origin: origin(),
      code: rec.getString("invite"),
      secret,
      name: siteName(app),
    });
  } catch (err) {
    throw fieldError(field, `That instance can't be reached: ${String(err).slice(0, 200)}`);
  }
  if (answer.status !== 200)
    throw fieldError(
      field,
      answer.status === 403
        ? "The request has expired or was withdrawn: ask that instance to send it again."
        : `Pairing failed: ${errorOf(answer)}`,
    );
  const body = jsonBody(answer) || {};
  rec.set("secret", secret);
  rec.set("status", "active");
  rec.set("invite", "");
  rec.set("invite_expires", "");
  if (body.name) rec.set("name", String(body.name).slice(0, 255));
  rec.set("last_ok", new DateTime());
  rec.set("last_error", "");
}

/**
 * fed_peers update request: the origin, secret and code stay as they are. A requested row becomes active by its admin
 * setting it so (which pairs); an invited one only by the other side accepting. Returns what changed, to act on once
 * saved.
 * @param {core.RecordRequestEvent} e
 */
function beforePeerEdit(e) {
  checkPeer(e);
  const rec = /** @type {core.Record} */ (e.record);
  const orig = rec.original();
  for (const f of ["origin", "secret", "invite", "invite_expires", "name"]) {
    if (rec.getString(f) !== orig.getString(f)) throw fieldError(f, "This field can't be changed.");
  }
  const was = orig.getString("status");
  const now = rec.getString("status");
  if (was !== now) {
    if (was === "invited") throw fieldError("status", "It becomes active once the other instance's admin accepts.");
    if (was === "requested" && now !== "active") throw fieldError("status", "Set it active to accept, or delete the row to decline.");
    if (now === "invited" || now === "requested") throw fieldError("status", "A paired instance is active or suspended.");
    if (was === "requested") {
      const off = offProblem(e.app);
      if (off) throw fieldError("status", off);
      pairNow(e.app, rec, "status");
    }
  }
  return { status: was !== now, dms: rec.getBool("dms") !== orig.getBool("dms") };
}

/**
 * fed_peers update request (saved): suspending holds its queue and shows its rooms as unreachable (§33.7); `dms`
 * opens or closes DMs with its people (§33.5).
 * @param {core.App} app
 * @param {core.Record} peer
 * @param {{ status: boolean, dms: boolean }} changed
 */
function afterPeerEdit(app, peer, changed) {
  if (changed.status) setDown(app, peer.id, !isActive(peer));
  if (changed.status || changed.dms) refreshDms(app, peer);
}

/**
 * Unpair here (§33.7): every share with the peer ends (mirrors archived, its people out of our rooms), and DMs with its
 * people become read-only. Stand-ins and their messages stay.
 * @param {core.App} app
 * @param {core.Record} peer
 */
function unpairHere(app, peer) {
  for (const share of app.findRecordsByFilter("fed_shares", "peer = {:p} && state != 'ended'", "created", 0, 0, { p: peer.id })) {
    if (share) endShare(app, share, false);
  }
  peer.set("status", "suspended");
  refreshDms(app, peer); // not active: no DMs
}

/**
 * fed_peers delete request: tell the peer (once, now: its queue goes with the row), then unpair here. A pending row
 * (asked or asking) tells the other side it is withdrawn or declined.
 * @param {core.App} app
 * @param {core.Record} peer
 */
function beforePeerDelete(app, peer) {
  const st = peer.getString("status");
  if (st === "invited" || st === "requested") {
    try {
      pairing(peer.getString("origin"), "/api/fed/cancel", { origin: origin(), code: peer.getString("invite") }, 5);
    } catch (err) {
      app.logger().warn("federation: cancel not delivered", "peer", peerHost(peer), "error", String(err));
    }
    return;
  }
  if (isActive(peer)) {
    try {
      call(peer, "POST", "/api/fed/inbox", { events: [{ id: newId(), type: "unpair" }] }, { seconds: 5 });
    } catch (err) {
      app.logger().warn("federation: unpair not delivered", "peer", peerHost(peer), "error", String(err));
    }
  }
  unpairHere(app, peer);
}

/**
 * An `unpair` event: the peer's admin unpaired. Unpair here and drop the row.
 * @param {core.App} app
 * @param {core.Record} peer
 */
function applyUnpair(app, peer) {
  app.runInTransaction((tx) => {
    const fresh = tx.findRecordById("fed_peers", peer.id);
    unpairHere(tx, fresh);
    tx.delete(fresh);
  });
  app.logger().info("federation: unpaired by the peer", "peer", peerHost(peer));
}

/**
 * A pairing request's { origin, code } (unsigned: the code says who it is). Throws 400 for a malformed one.
 * @param {core.RequestEvent} e
 */
function pairingBody(e) {
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const from = typeof body.origin === "string" ? cleanOrigin(body.origin) : "";
  const code = typeof body.code === "string" ? body.code : "";
  if (!from || !/^[A-Za-z0-9]{32}$/.test(code)) throw new BadRequestError("Missing origin or code.");
  return { from, code, body };
}

/**
 * Is `code` this row's open invite?
 * @param {core.Record | null} peer
 * @param {string} code
 */
function invites(peer, code) {
  if (peer?.getString("status") !== "invited") return false;
  const want = peer.getString("invite");
  const expires = peer.getDateTime("invite_expires");
  if (!want || !$security.equal(code, want)) return false;
  return !expires.isZero() && expires.time().unixMilli() >= Date.now();
}

/**
 * POST /api/fed/request { origin, code, name }: an instance asking to link (§33.3, step 1). Checked by asking it back
 * (POST /api/fed/verify there) before anything is saved, so only a real request shows. Shows as a requested row; if
 * this side asked that instance already, they pair at once.
 * @param {core.RequestEvent} e
 */
function request(e) {
  const { from, code, body } = pairingBody(e);
  if (!from.startsWith("https://") && !allowPrivate()) throw new BadRequestError("Instances are linked over https only.");
  if (hostOf(from) === myHost()) throw new BadRequestError("That is this instance.");
  const there = peerByOrigin(e.app, from);
  const st = there?.getString("status") || "";
  if (st === "active" || st === "suspended")
    throw new ApiError(409, `${hostOf(origin())} is paired with it already: its admin can delete the row there to pair again.`);
  if (!there && e.app.findRecordsByFilter("fed_peers", "status = 'requested'", "", MAX_REQUESTED, 0).length >= MAX_REQUESTED)
    throw new TooManyRequestsError("Too many requests are waiting here.");
  /** @type {ReturnType<typeof pairing>} */
  let check;
  try {
    check = pairing(from, "/api/fed/verify", { origin: origin(), code }, 10);
  } catch (err) {
    throw new BadRequestError(`It can't be reached to check the request: ${String(err).slice(0, 200)}`);
  }
  if (check.status !== 200) {
    e.app.logger().warn("federation: a request not confirmed by its origin", "origin", from, "status", check.status);
    throw new ForbiddenError("That instance didn't confirm the request.");
  }
  const name = String(jsonBody(check)?.name || body.name || "").slice(0, 255);
  if (st === "invited" && invites(there, there?.getString("invite") || "")) {
    // Both asked: give it this side's code, and it pairs with it at once (as an admin accepting would).
    e.app.logger().info("federation: both asked", "peer", hostOf(from));
    return e.json(200, { name: siteName(e.app), code: /** @type {core.Record} */ (there).getString("invite") });
  }
  // A request this side sent that expired becomes theirs.
  const rec = there || new Record(e.app.findCollectionByNameOrId("fed_peers"));
  if (!there) {
    rec.set("origin", from);
    rec.set("label", suggestLabel(e.app, hostOf(from)));
    rec.set("dms", false);
  }
  rec.set("status", "requested");
  rec.set("last_ok", "");
  rec.set("invite", code);
  rec.set("invite_expires", new DateTime(new Date(Date.now() + INVITE_MS).toISOString()));
  rec.set("name", name);
  rec.set("last_error", "");
  e.app.save(rec);
  e.app.logger().info("federation: link requested", "origin", from);
  return e.json(200, { name: siteName(e.app) });
}

/**
 * POST /api/fed/verify { origin, code }: did this instance ask `origin` to link, with this code? The asked side's check
 * (§33.3), answered with the site name.
 * @param {core.RequestEvent} e
 */
function verifyRequest(e) {
  const { from, code } = pairingBody(e);
  const asking = String(e.app.store().get(ASKING_KEY(from)) || "");
  if (!(asking && $security.equal(code, asking)) && !invites(peerByOrigin(e.app, from), code)) throw new ForbiddenError("No such request.");
  return e.json(200, { name: siteName(e.app) });
}

/**
 * POST /api/fed/pair { origin, code, secret, name }: the asked instance accepting the request this one sent (§33.3,
 * step 3). Not signed (there is no secret yet): the code, used once and compared in constant time, says who it is.
 * @param {core.RequestEvent} e
 */
function pair(e) {
  const { from, code, body } = pairingBody(e);
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new BadRequestError("Missing origin, code or secret.");
  let ok = false;
  e.app.runInTransaction((tx) => {
    const peer = peerByOrigin(tx, from);
    if (!peer || !invites(peer, code)) return;
    peer.set("secret", secret);
    peer.set("status", "active");
    peer.set("invite", "");
    peer.set("invite_expires", "");
    peer.set("name", String(body.name || "").slice(0, 255));
    peer.set("last_ok", new DateTime());
    peer.set("last_error", "");
    tx.save(peer);
    ok = true;
  });
  if (!ok) {
    e.app.logger().warn("federation: pairing refused", "origin", from);
    throw new ForbiddenError("This code isn't valid.");
  }
  return e.json(200, { name: siteName(e.app), origin: origin() });
}

/**
 * POST /api/fed/cancel { origin, code }: the other side deleted its pending row. A request it sent is withdrawn (the
 * row goes); one this side sent was declined (noted on the row, for its admin to delete).
 * @param {core.RequestEvent} e
 */
function cancel(e) {
  const { from, code } = pairingBody(e);
  const peer = peerByOrigin(e.app, from);
  const st = peer?.getString("status");
  if (!peer || (st !== "invited" && st !== "requested") || !$security.equal(code, peer.getString("invite")))
    throw new ForbiddenError("No such request.");
  if (st === "requested") {
    e.app.delete(peer);
  } else {
    peer.set("last_error", `${hostOf(from)} declined.`);
    e.app.save(peer);
  }
  return e.json(200, {});
}

/**
 * The worker's look at pending rows, once a run: requests not delivered yet are sent again, expired ones end (a
 * requested row goes, an invited one says so).
 * @param {core.App} app
 */
function pendingPass(app) {
  for (const p of app.findRecordsByFilter("fed_peers", "status = 'invited' || status = 'requested'", "created", 0, 0)) {
    if (!p) continue;
    const expires = p.getDateTime("invite_expires");
    const expired = expires.isZero() || expires.time().unixMilli() < Date.now();
    if (p.getString("status") === "requested") {
      if (expired) app.delete(p);
      continue;
    }
    if (expired) {
      if (p.getString("last_error") !== EXPIRED) {
        p.set("last_error", EXPIRED);
        app.save(p);
      }
    } else if (p.getDateTime("last_ok").isZero() && (!p.getString("last_error") || p.getString("last_error").startsWith(UNREACHED))) {
      const r = ask(app, p);
      const code = p.getString("invite");
      try {
        noteAsked(app, p, r, "origin");
      } catch (err) {
        p.set("invite", code);
        p.set("last_error", `Pairing failed: ${String(err).slice(0, 300)}`);
      }
      app.save(p);
    }
  }
}

module.exports = {
  beforePeerCreate,
  beforePeerEdit,
  afterPeerEdit,
  beforePeerDelete,
  applyUnpair,
  request,
  verifyRequest,
  pair,
  cancel,
  pendingPass,
  siteName,
};
