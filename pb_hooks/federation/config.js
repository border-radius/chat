/// <reference path="../../types/pocketbase.d.ts" />
// Linked instances (DESIGN.md §33): this server's origin, global ids, peers, and the queue every part writes to.

/** Tests and development only: peers on private addresses and plain http (§33.6). */
const allowPrivate = () => $os.getenv("FEDERATION_ALLOW_PRIVATE").trim() === "1";

/**
 * An origin as stored: scheme and host (and port), lowercased, no path. "" for anything else.
 * @param {string} raw
 */
function cleanOrigin(raw) {
  const m = /^(https?):\/\/([a-z0-9.-]+(?::\d+)?)\/?$/i.exec(String(raw || "").trim());
  if (!m) return "";
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}`;
}

/** This server's public origin: the Application URL (Settings → Application), as stored. "" when it isn't one. */
const origin = () => cleanOrigin($app.settings().meta.appURL);

/**
 * Why this server can't link with others, or "" when it can: the Application URL must be its public https address
 * (http and localhost only with FEDERATION_ALLOW_PRIVATE).
 * @param {string} [o] an Application URL to check instead of the current one
 */
function originProblem(o = origin()) {
  const c = cleanOrigin(o);
  if (!c) return "Set the Application URL (Settings → Application) to this server's public address, like https://chat.example.org.";
  if (allowPrivate()) return "";
  if (!c.startsWith("https://")) return "The Application URL must be this server's public https:// address.";
  if (/^https:\/\/(localhost|127\.|\[?::1)/.test(c)) return "The Application URL must be this server's public address, not localhost.";
  return "";
}

/**
 * Is the module on (§33.2): the site record's `federation` ticked, and an Application URL that can be linked with.
 * Off, the /api/fed/ routes answer 404 and the worker sends nothing.
 * @param {core.App} app
 */
function enabled(app) {
  if (originProblem()) return false;
  const found = app.findRecordsByFilter("site", "", "created", 1, 0);
  return !!found[0]?.getBool("federation");
}

/**
 * The /api/fed/ routes (and remote-users) while the module is off: 404, as on a server without it.
 * @param {core.App} app
 */
function requireOn(app) {
  if (!enabled(app)) throw new NotFoundError("Linking with other instances is off here.");
}

const IN_USE_KEY = "fed.inUse";

/**
 * Has this instance any fed_peers row at all: the record hooks have nothing to do without one, and skip their queries.
 * Kept in the app store, dropped whenever a row is created or deleted.
 * @param {core.App} app
 */
function inUse(app) {
  const known = app.store().get(IN_USE_KEY);
  if (known !== undefined && known !== null) return !!known;
  const any = app.findRecordsByFilter("fed_peers", "", "", 1, 0).length > 0;
  app.store().set(IN_USE_KEY, any);
  return any;
}

/** @param {core.App} app */
const forgetInUse = (app) => app.store().remove(IN_USE_KEY);

/**
 * The host of an origin, lowercased, with its port if it has one: "https://B.example" → "b.example".
 * @param {string} o
 */
const hostOf = (o) =>
  o
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

/** This server's host, as global ids end in. Changing the Application URL's host is refused while paired (§33.2). */
const myHost = () => hostOf(origin());

/**
 * A thing's global id (§33.6): its id on the instance it was made on, and that instance's host.
 * @param {string} id
 * @param {string} [host]
 */
const gid = (id, host = myHost()) => `${id}@${host}`;

/**
 * A global id split at its last "@": { id, host }. Null for anything else.
 * @param {unknown} g
 */
function splitGid(g) {
  if (typeof g !== "string") return null;
  const at = g.lastIndexOf("@");
  if (at < 1 || at === g.length - 1 || g.length > 300) return null;
  const id = g.slice(0, at);
  if (!/^[a-z0-9]{1,64}$/i.test(id)) return null;
  return { id, host: g.slice(at + 1).toLowerCase() };
}

/** Is this global id one of this instance's own? @param {string} g */
const isMine = (g) => splitGid(g)?.host === myHost();

/** A new record id, as PocketBase makes them. */
const newId = () => $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789");

/**
 * @param {core.App} app
 * @param {string} id
 */
function peerById(app, id) {
  if (!id) return null;
  try {
    return app.findRecordById("fed_peers", id);
  } catch {
    return null;
  }
}

/**
 * @param {core.App} app
 * @param {string} o
 */
function peerByOrigin(app, o) {
  try {
    return app.findFirstRecordByFilter("fed_peers", "origin = {:o}", { o: o.replace(/\/+$/, "") });
  } catch {
    return null;
  }
}

/**
 * The peer whose host this is, or null.
 * @param {core.App} app
 * @param {string} host
 */
function peerByHost(app, host) {
  for (const p of app.findRecordsByFilter("fed_peers", "", "created", 0, 0)) {
    if (p && hostOf(p.getString("origin")) === host) return p;
  }
  return null;
}

/** @param {core.Record} peer */
const peerHost = (peer) => hostOf(peer.getString("origin"));

/** @param {core.Record | null} peer */
const isActive = (peer) => !!peer && peer.getString("status") === "active";

/**
 * The next queue position: microseconds since 1970, one more than the last at least, so rows queued in the same
 * millisecond keep their order.
 * @param {core.App} app
 */
function nextSeq(app) {
  let seq = 0;
  app.store().setFunc("fed.seq", (old) => {
    seq = Math.max(Number(old || 0) + 1, Date.now() * 1000);
    return seq;
  });
  return seq;
}

/**
 * Queue an event for a peer (§33.8). It goes in the caller's transaction, so it is sent only if what it tells of is
 * saved. Its id is the queue row's: unique here, which is what the peer drops repeats by.
 * @param {core.App} app
 * @param {string} peerId
 * @param {Record<string, unknown>} event
 */
function enqueue(app, peerId, event) {
  const row = new Record(app.findCollectionByNameOrId("fed_queue"));
  const id = newId();
  row.set("id", id);
  row.set("peer", peerId);
  row.set("op", "event");
  row.set("seq", nextSeq(app));
  row.set("payload", { ...event, id });
  app.save(row);
}

/**
 * Queue other work for the worker: files ("fetch") or an avatar ("avatar") to fetch from a peer.
 * @param {core.App} app
 * @param {string} peerId
 * @param {"fetch" | "avatar"} op
 * @param {Record<string, unknown>} payload
 */
function enqueueWork(app, peerId, op, payload) {
  const row = new Record(app.findCollectionByNameOrId("fed_queue"));
  row.set("peer", peerId);
  row.set("op", op);
  row.set("seq", nextSeq(app));
  row.set("payload", payload);
  app.save(row);
}

// ---------------------------------------------------------------- what came from a peer

/**
 * Saves made for a peer's event say so here, by record id, while they run: the hooks then don't send the change back
 * where it came from (a mirror's own people's changes go to the home; the home's to every mirror but the sender).
 * In the app store, which every hook sees, whichever JS runtime it runs in.
 * @param {string} id
 */
const ORIGIN_KEY = (id) => `fed.origin.${id}`;

/**
 * Run `fn` with record `id`'s saves marked as coming from `peerId`.
 * @template T
 * @param {core.App} app
 * @param {string} id
 * @param {string} peerId
 * @param {() => T} fn
 * @returns {T}
 */
function fromPeer(app, id, peerId, fn) {
  app.store().set(ORIGIN_KEY(id), peerId);
  try {
    return fn();
  } finally {
    app.store().remove(ORIGIN_KEY(id));
  }
}

/**
 * The peer a save of record `id` is being made for, "" when it is this instance's own.
 * @param {core.App} app
 * @param {string} id
 */
const originOf = (app, id) => String(app.store().get(ORIGIN_KEY(id)) || "");

/**
 * Read a JSON field as a value ({} or [] when empty or bad).
 * @param {core.Record} rec
 * @param {string} field
 * @param {any} fallback
 */
function jsonOf(rec, field, fallback) {
  try {
    const v = JSON.parse(rec.getString(field) || "null");
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

module.exports = {
  origin,
  allowPrivate,
  cleanOrigin,
  originProblem,
  enabled,
  requireOn,
  inUse,
  forgetInUse,
  hostOf,
  myHost,
  gid,
  splitGid,
  isMine,
  newId,
  peerById,
  peerByOrigin,
  peerByHost,
  peerHost,
  isActive,
  enqueue,
  enqueueWork,
  fromPeer,
  originOf,
  jsonOf,
};
