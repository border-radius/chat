/// <reference path="../../types/pocketbase.d.ts" />
// Pairing (DESIGN.md §33.3) and unpairing (§33.7), by superusers in the admin UI (Collections → fed_peers).
// - Inviting: a row with the other instance's origin and a label, no code. It gets a one-time code (in `invite`, valid
//   24 hours) to give that instance's admin.
// - Joining: a row with the inviting instance's origin, a label and the code. Saving it pairs: this side makes the
//   secret and sends it with the code to POST /api/fed/pair over https; both rows are then active.
// - Suspending (status → suspended) holds everything until it is active again; deleting the row unpairs.

const { fieldError } = require(`${__hooks}/lib/records.js`);
const { allowPrivate, hostOf, isActive, myHost, newId, origin, peerByOrigin, peerHost } = require(`${__hooks}/federation/config.js`);
const { call, errorOf, jsonBody, pairWith } = require(`${__hooks}/federation/net.js`);
const { refreshDms } = require(`${__hooks}/federation/people.js`);
const { endShare, setDown } = require(`${__hooks}/federation/rooms.js`);

/** How long an invite code may be used. */
const INVITE_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const HEX = "0123456789abcdef";

/** @param {core.App} app */
function siteName(app) {
  const found = app.findRecordsByFilter("site", "", "created", 1, 0);
  return found[0]?.getString("title") || "Chat";
}

/**
 * An origin as stored: scheme and host (and port), lowercased, no path.
 * @param {string} raw
 */
function cleanOrigin(raw) {
  const m = /^(https?):\/\/([a-z0-9.-]+(?::\d+)?)\/?$/i.exec(raw.trim());
  if (!m) return "";
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}`;
}

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
 * fed_peers create request: invite the other instance, or join it with its code.
 * @param {core.RecordRequestEvent} e
 */
function beforePeerCreate(e) {
  checkPeer(e);
  const rec = /** @type {core.Record} */ (e.record);
  if (peerByOrigin(e.app, rec.getString("origin"))) throw fieldError("origin", "This instance is listed already.");
  rec.set("last_ok", "");
  rec.set("last_error", "");
  rec.set("name", "");
  const code = rec.getString("invite").trim();
  if (!code) {
    rec.set("secret", "");
    rec.set("status", "invited");
    rec.set("invite", $security.randomStringWithAlphabet(32, CODE_ALPHABET));
    rec.set("invite_expires", new DateTime(new Date(Date.now() + INVITE_MS).toISOString()));
    return;
  }
  const secret = $security.randomStringWithAlphabet(64, HEX);
  /** @type {ReturnType<typeof pairWith>} */
  let answer;
  try {
    answer = pairWith(rec.getString("origin"), { origin: origin(), code, secret, name: siteName(e.app) });
  } catch (err) {
    throw fieldError("origin", `That instance can't be reached: ${String(err).slice(0, 200)}`);
  }
  if (answer.status !== 200)
    throw fieldError(
      "invite",
      answer.status === 403 ? "This code isn't valid (or was used, or expired)." : `Pairing failed: ${errorOf(answer)}`,
    );
  const body = jsonBody(answer) || {};
  rec.set("secret", secret);
  rec.set("status", "active");
  rec.set("invite", "");
  rec.set("invite_expires", "");
  rec.set("name", String(body.name || "").slice(0, 255));
  rec.set("last_ok", new DateTime());
}

/**
 * fed_peers update request: the origin, secret and code stay as they are; an invited peer stays invited until it pairs.
 * Returns what changed, to act on once saved.
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
  if (was !== now && (was === "invited" || now === "invited")) throw fieldError("status", "An invited instance becomes active by pairing.");
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
 * fed_peers delete request: tell the peer (once, now: its queue goes with the row), then unpair here.
 * @param {core.App} app
 * @param {core.Record} peer
 */
function beforePeerDelete(app, peer) {
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
 * POST /api/fed/pair { origin, code, secret, name }: an instance joining with the code this one gave (§33.3, step 3).
 * Not signed (there is no secret yet): the code, used once and compared in constant time, says who it is.
 * @param {core.RequestEvent} e
 */
function pair(e) {
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const from = typeof body.origin === "string" ? cleanOrigin(body.origin) : "";
  const code = typeof body.code === "string" ? body.code : "";
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!from || !code || !/^[0-9a-f]{64}$/.test(secret)) throw new BadRequestError("Missing origin, code or secret.");
  const refused = () => new ForbiddenError("This code isn't valid.");
  let ok = false;
  e.app.runInTransaction((tx) => {
    const peer = peerByOrigin(tx, from);
    if (peer?.getString("status") !== "invited") return;
    const want = peer.getString("invite");
    const expires = peer.getDateTime("invite_expires");
    if (!want || !$security.equal(code, want)) return;
    if (expires.isZero() || expires.time().unixMilli() < Date.now()) return;
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
    throw refused();
  }
  return e.json(200, { name: siteName(e.app), origin: origin() });
}

module.exports = { beforePeerCreate, beforePeerEdit, afterPeerEdit, beforePeerDelete, applyUnpair, pair, siteName };
