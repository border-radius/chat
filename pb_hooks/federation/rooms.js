/// <reference path="../../types/pocketbase.d.ts" />
// Shared rooms (DESIGN.md §33.5): a room lives on its home; each instance it is shared with keeps a mirror, an
// ordinary room whose `peer` is the home and `remote_id` the room's global id. The home sends the room's state (a
// `room` event) whenever it changes; a mirror takes it as it comes. Rooms are shared by superusers on both sides
// (fed_shares rows); DMs with a peer's people are shared as they are opened.

const { MAX_MEMBERS } = require(`${__hooks}/lib/access.js`);
const { postService } = require(`${__hooks}/lib/messages.js`);
const { fieldError } = require(`${__hooks}/lib/records.js`);
const { nameKey, stripHashes, tidy } = require(`${__hooks}/lib/text.js`);
const { enqueue, gid, isActive, jsonOf, myHost, newId, peerById, peerHost, splitGid } = require(`${__hooks}/federation/config.js`);
const { gidOf, peopleFor, standInRow, userOf } = require(`${__hooks}/federation/people.js`);

/** rooms.name max. */
const ROOM_NAME_MAX = 48;
/** What a share sends of a room's history when it starts (§33.11, milestone 6). */
const BACKFILL = 200;

/**
 * A refusal of a peer's event: its status goes back in the inbox's answer (§33.6).
 * @param {number} status
 * @param {string} message
 */
function refusal(status, message) {
  const err = /** @type {Error & { status?: number }} */ (new Error(message));
  err.status = status;
  return err;
}

/** @param {core.Record} room */
const isMirror = (room) => room.getString("peer") !== "";

/** The room's global id. @param {core.Record} room */
const roomGid = (room) => (isMirror(room) ? room.getString("remote_id") : gid(room.id));

/**
 * @param {core.App} app
 * @param {string} id
 */
function findRoom(app, id) {
  if (!id) return null;
  try {
    return app.findRecordById("rooms", id);
  } catch {
    return null;
  }
}

/**
 * The room's shares in these states.
 * @param {core.App} app
 * @param {string} roomId
 * @param {string[]} [states]
 */
function sharesOf(app, roomId, states = ["active"]) {
  const rows = /** @type {core.Record[]} */ (
    app.findRecordsByFilter("fed_shares", "room = {:r}", "created", 0, 0, { r: roomId }).filter(Boolean)
  );
  return rows.filter((s) => states.includes(s.getString("state")));
}

/**
 * The share of the room with `peerId` that isn't over, or null.
 * @param {core.App} app
 * @param {string} roomId
 * @param {string} peerId
 */
function shareOf(app, roomId, peerId) {
  const rows = app.findRecordsByFilter("fed_shares", "room = {:r} && peer = {:p} && state != 'ended'", "created", 1, 0, {
    r: roomId,
    p: peerId,
  });
  return rows[0] || null;
}

/**
 * On a mirror's side: the share of the home's room `g` with peer `peerId` that isn't over, or null.
 * @param {core.App} app
 * @param {string} peerId
 * @param {string} g
 */
function offerOf(app, peerId, g) {
  const rows = app.findRecordsByFilter("fed_shares", "peer = {:p} && remote_id = {:g} && state != 'ended'", "created", 1, 0, {
    p: peerId,
    g,
  });
  return rows[0] || null;
}

/**
 * The room a peer's event names, as the peer may name it: one of ours shared with it (`home`), or a mirror of one of
 * its rooms. Null otherwise.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {unknown} g
 * @returns {{ room: core.Record, home: boolean } | null}
 */
function roomFor(app, sender, g) {
  const s = splitGid(g);
  if (!s) return null;
  if (s.host === myHost()) {
    const room = findRoom(app, s.id);
    if (!room || isMirror(room)) return null;
    const share = shareOf(app, room.id, sender.id);
    return share && share.getString("state") === "active" ? { room, home: true } : null;
  }
  if (s.host !== peerHost(sender)) return null;
  const share = offerOf(app, sender.id, /** @type {string} */ (g));
  if (share?.getString("state") !== "active") return null;
  const room = findRoom(app, share.getString("room"));
  return room ? { room, home: false } : null;
}

// ---------------------------------------------------------------- the home's side

/**
 * The room's state as a `room` event to `peer` (§33.6): people as global ids, with the profiles it may not have.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {core.Record} peer
 * @param {string} [refused] why its `members` request was refused
 */
function roomEvent(app, room, peer, refused = "") {
  const members = room.getStringSlice("members");
  const writers = room.getStringSlice("writers");
  const creator = room.getString("created_by");
  const shared = jsonOf(room, "shared", {});
  return {
    type: "room",
    room: gid(room.id),
    name: room.getString("name"),
    kind: room.getString("kind"),
    visibility: room.getString("visibility"),
    posting: room.getString("posting"),
    archived: room.getBool("archived"),
    created_by: gidOf(app, creator),
    members: members.map((id) => gidOf(app, id)),
    writers: writers.map((id) => gidOf(app, id)),
    shared_with: [myHost(), ...(Array.isArray(shared.with) ? shared.with : [])],
    people: peopleFor(app, peer, [creator, ...members, ...writers]),
    ...(refused ? { refused } : {}),
  };
}

/**
 * Send the room's state to every peer it is shared with (or only `onlyPeer`).
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} [onlyPeer]
 * @param {string} [refused]
 */
function sendRoom(app, room, onlyPeer = "", refused = "") {
  for (const share of sharesOf(app, room.id)) {
    const peer = peerById(app, share.getString("peer"));
    if (!peer || (onlyPeer && peer.id !== onlyPeer)) continue;
    enqueue(app, peer.id, roomEvent(app, room, peer, refused));
  }
}

/**
 * A field's value, comparable with ===: lists of relations joined (getString has nothing for them), JSON as parsed.
 * @param {core.Record} r
 * @param {string} f
 */
const fieldValue = (r, f) =>
  f === "members" || f === "writers" ? r.getStringSlice(f).join(",") : f === "shared" ? JSON.stringify(jsonOf(r, f, {})) : r.getString(f);

/** What a room event says, compared before and after a save. @param {core.Record} r */
const stateOf = (r) =>
  ["name", "kind", "visibility", "posting", "archived", "created_by", "members", "writers", "shared"]
    .map((f) => fieldValue(r, f))
    .join("|");

/**
 * rooms update (saved): a home room that is shared sends its new state to every mirror.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} before stateOf the room before
 */
function roomChanged(app, room, before) {
  if (isMirror(room) || stateOf(room) === before) return;
  sendRoom(app, room);
}

/**
 * Set the home room's `shared` (§33.10: who else holds it) from its active shares. Saves it when that changed, which
 * sends its state to every mirror. Returns whether it saved.
 * @param {core.App} app
 * @param {core.Record} room
 */
function refreshShared(app, room) {
  const hosts = sharesOf(app, room.id)
    .map((s) => peerById(app, s.getString("peer")))
    .filter((p) => !!p)
    .map((p) => peerHost(/** @type {core.Record} */ (p)));
  const want = hosts.length ? { with: hosts } : {};
  if (JSON.stringify(jsonOf(room, "shared", {})) === JSON.stringify(want)) return false;
  room.set("shared", want);
  app.save(room);
  return true;
}

/**
 * rooms create (saved): a DM opened with a peer's person (POST /api/chat/dms) is shared with that peer at once
 * (§33.5): the home is here, and the peer makes its mirror. Who may DM whom was checked by the DM route (no_dms on the
 * stand-in says whether their instance takes DMs from here).
 * @param {core.App} app
 * @param {core.Record} room
 */
function roomCreated(app, room) {
  if (isMirror(room) || room.getString("kind") !== "dm") return;
  for (const id of room.getStringSlice("members")) {
    const row = standInRow(app, id);
    if (!row) continue;
    const peer = peerById(app, row.getString("peer"));
    if (!peer || !isActive(peer)) throw fieldError("members", "That instance can't be reached.");
    const share = new Record(app.findCollectionByNameOrId("fed_shares"));
    share.set("room", room.id);
    share.set("peer", peer.id);
    share.set("state", "active");
    share.set("kind", "dm");
    share.set("visibility", "private");
    app.save(share);
    refreshShared(app, room);
  }
}

/**
 * rooms update request on a home room: people from other instances may be made members or writers only when the room
 * is shared with their instance (§33.5), so its creator can't take it where the admins didn't.
 * @param {core.RecordRequestEvent} e
 */
function checkHomeMembers(e) {
  const rec = e.record;
  if (!rec || isMirror(rec)) return;
  const orig = rec.original();
  for (const field of ["members", "writers"]) {
    const was = new Set(orig.getStringSlice(field));
    for (const id of rec.getStringSlice(field)) {
      if (was.has(id)) continue;
      const row = standInRow(e.app, id);
      if (!row) continue;
      const share = shareOf(e.app, rec.id, row.getString("peer"));
      if (share?.getString("state") !== "active") {
        throw fieldError(field, "This room isn't shared with that person's instance.");
      }
    }
  }
}

/**
 * A `members` request from a mirror (§33.5): its own people in or out of a private room. Applied unless it breaks a
 * rule, then the room goes back to every mirror (the sender learns the outcome from it, `refused` saying why not).
 * A refusal is answered, not thrown: the room sent back with it must be kept.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 * @returns {{ status: number, error: string } | void}
 */
function applyMembers(app, sender, ev) {
  const found = roomFor(app, sender, ev.room);
  if (!found?.home) throw refusal(403, "That room isn't shared with you from here.");
  const room = found.room;
  const refuse = (/** @type {string} */ why) => {
    sendRoom(app, room, sender.id, why);
    return { status: 403, error: why };
  };
  if (room.getString("kind") !== "public" || room.getString("visibility") !== "private")
    return refuse("Only a private room's members are listed.");
  if (room.getBool("archived")) return refuse("This room is archived.");
  const add = Array.isArray(ev.add) ? ev.add.map(String) : [];
  const remove = Array.isArray(ev.remove) ? ev.remove.map(String) : [];
  const host = peerHost(sender);
  if ([...add, ...remove].some((g) => splitGid(g)?.host !== host)) return refuse("Only your own people can be added or removed.");
  const members = new Set(room.getStringSlice("members"));
  for (const g of remove) {
    const id = userOf(app, sender, g, {}, true);
    if (id && id !== room.getString("created_by")) members.delete(id);
  }
  for (const g of add) {
    const id = userOf(app, sender, g, ev.people || {}, true);
    if (!id) return refuse("Someone to add is unknown.");
    members.add(id);
  }
  if (members.size > MAX_MEMBERS) return refuse(`A room has at most ${MAX_MEMBERS} members.`);
  const before = room.getStringSlice("members").join(",");
  room.set("members", [...members]);
  if (room.getStringSlice("members").join(",") === before) {
    sendRoom(app, room, sender.id);
    return;
  }
  app.save(room); // its state goes to every mirror (roomChanged)
}

/**
 * Remove a peer's people from a home room's members and writers (a share that ended, §33.5).
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} peerId
 */
function dropPeople(app, room, peerId) {
  if (room.getString("kind") === "dm") return;
  const theirs = (/** @type {string} */ id) => standInRow(app, id)?.getString("peer") === peerId;
  const members = room.getStringSlice("members");
  const writers = room.getStringSlice("writers");
  if (!members.some(theirs) && !writers.some(theirs)) return;
  room.set(
    "members",
    members.filter((id) => !theirs(id)),
  );
  room.set(
    "writers",
    writers.filter((id) => !theirs(id)),
  );
  app.save(room);
}

/**
 * A service message, unless the room is gone or archived.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} text
 */
function tell(app, room, text) {
  const fresh = findRoom(app, room.id);
  if (fresh && !fresh.getBool("archived") && fresh.getString("kind") !== "dm") postService(app, fresh.id, text);
}

/**
 * End a share on this side (§33.5): on the home, the peer's people leave the room; on a mirror, it is archived and
 * keeps its history. Both sides say so in the room. `tellPeer`: send `unshare` (when it ends here first).
 * @param {core.App} app
 * @param {core.Record} share
 * @param {boolean} tellPeer
 */
function endShare(app, share, tellPeer) {
  const was = share.getString("state");
  if (was === "ended") return;
  const peer = peerById(app, share.getString("peer"));
  const host = peer ? peerHost(peer) : "another instance";
  const room = findRoom(app, share.getString("room"));
  const mirror = share.getString("remote_id") !== "";
  if (tellPeer && peer) enqueue(app, peer.id, { type: "unshare", room: mirror ? share.getString("remote_id") : room ? gid(room.id) : "" });
  share.set("state", "ended");
  app.save(share);
  if (!room || was !== "active") return;
  if (mirror) {
    tell(app, room, `This room is no longer shared with ${host}.`);
    // Kept as it was, read-only, and no longer said to be shared (§33.5). A DM is closed by its stand-in's no_dms.
    const fresh = findRoom(app, room.id);
    if (fresh) {
      if (fresh.getString("kind") !== "dm") fresh.set("archived", true);
      fresh.set("shared", {});
      app.save(fresh);
    }
  } else {
    tell(app, room, `This room is no longer shared with ${host}.`);
    dropPeople(app, room, share.getString("peer"));
    refreshShared(app, room);
  }
}

/**
 * Queue the room's latest messages for a peer that just took it (§33.11, milestone 6), oldest first.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {core.Record} peer
 */
function backfill(app, room, peer) {
  const { messageEvent } = require(`${__hooks}/federation/messages.js`);
  const recs = app.findRecordsByFilter("messages", "room = {:r} && deleted = false && author != ''", "-created,-id", BACKFILL, 0, {
    r: room.id,
  });
  // Backwards by index: recs is a Go slice, which reverse() garbles in place (its second half became the first's
  // copies, so half the messages went twice and the newest half never).
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    if (!rec) continue;
    const ev = messageEvent(app, rec, peer);
    if (ev) enqueue(app, peer.id, { ...ev, backfill: true });
  }
}

// ---------------------------------------------------------------- superusers sharing (fed_shares requests)

/**
 * fed_shares create request: a superuser on the home offers a room to a peer (§33.5, step 1).
 * @param {core.RecordRequestEvent} e
 */
function beforeOffer(e) {
  const rec = /** @type {core.Record} */ (e.record);
  const room = findRoom(e.app, rec.getString("room"));
  if (!room) throw fieldError("room", "Choose the room to share.", "validation_required");
  if (isMirror(room)) throw fieldError("room", "This room is shared with this instance; only its home can share it.");
  if (room.getString("kind") === "dm") throw fieldError("room", "Direct messages are shared as they are opened.");
  if (room.getBool("archived")) throw fieldError("room", "This room is archived.");
  const peer = peerById(e.app, rec.getString("peer"));
  if (!peer || !isActive(peer)) throw fieldError("peer", "Choose an instance this one is paired with.");
  if (shareOf(e.app, room.id, peer.id)) throw fieldError("room", "This room is already shared with that instance.");
  // An ended share before it makes way: sharing again starts afresh.
  for (const old of e.app.findRecordsByFilter("fed_shares", "room = {:r} && peer = {:p}", "", 0, 0, { r: room.id, p: peer.id })) {
    if (old) e.app.delete(old);
  }
  rec.set("remote_id", "");
  rec.set("state", "offered");
  rec.set("accepted", false);
  rec.set("last_error", "");
  rec.set("name", room.getString("name"));
  rec.set("kind", room.getString("kind"));
  rec.set("visibility", room.getString("visibility"));
}

/**
 * fed_shares create request (saved): tell the peer.
 * @param {core.App} app
 * @param {core.Record} share
 */
function afterOffer(app, share) {
  const room = /** @type {core.Record} */ (findRoom(app, share.getString("room")));
  enqueue(app, share.getString("peer"), {
    type: "share",
    room: gid(room.id),
    name: room.getString("name"),
    kind: room.getString("kind"),
    visibility: room.getString("visibility"),
  });
}

/**
 * fed_shares update request: a peer's superuser accepts an offer (ticks `accepted`), or either side ends a share
 * (`state` → ended). Nothing else of a share changes by hand. Returns what to do once saved.
 * @param {core.RecordRequestEvent} e
 * @returns {"" | "accept" | "end"}
 */
function beforeShareEdit(e) {
  const rec = /** @type {core.Record} */ (e.record);
  const orig = rec.original();
  for (const f of ["room", "peer", "remote_id", "name", "kind", "visibility"]) {
    if (rec.getString(f) !== orig.getString(f)) throw fieldError(f, "This field can't be changed.");
  }
  const state = rec.getString("state");
  if (state !== orig.getString("state")) {
    if (state !== "ended") throw fieldError("state", "A share can only be ended here.");
    // Ended once saved, by endShare, which needs it as it was.
    rec.set("state", orig.getString("state"));
    rec.set("accepted", orig.getBool("accepted"));
    return "end";
  }
  if (rec.getBool("accepted") !== orig.getBool("accepted")) {
    if (!orig.getString("remote_id")) throw fieldError("accepted", "The peer accepts a room you offer.");
    if (!rec.getBool("accepted") || orig.getString("state") !== "offered")
      throw fieldError("accepted", "It can't be taken back; end the share instead.");
    return "accept";
  }
  return "";
}

/**
 * fed_shares update request (saved).
 * @param {core.App} app
 * @param {core.Record} share
 * @param {"" | "accept" | "end"} what
 */
function afterShareEdit(app, share, what) {
  if (what === "accept") enqueue(app, share.getString("peer"), { type: "share", room: share.getString("remote_id"), accepted: true });
  if (what === "end") endShare(app, app.findRecordById("fed_shares", share.id), true);
}

/**
 * fed_shares delete request: a superuser declines an offer or ends a share; the peer is told.
 * @param {core.App} app
 * @param {core.Record} share
 */
function beforeShareDelete(app, share) {
  endShare(app, share, true);
}

// ---------------------------------------------------------------- events from the peer

/**
 * A `share` event: an offer from a home (§33.5, step 2), or the peer's answer to ours.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyShare(app, sender, ev) {
  const s = splitGid(ev.room);
  if (!s) throw refusal(400, "No room.");
  if (s.host === myHost()) {
    // Our offer, taken.
    const room = findRoom(app, s.id);
    const share = room ? shareOf(app, room.id, sender.id) : null;
    if (!room || !share) throw refusal(404, "That room isn't offered to you.");
    if (!ev.accepted || share.getString("state") !== "offered") return;
    share.set("state", "active");
    share.set("accepted", true);
    app.save(share);
    if (!refreshShared(app, room)) sendRoom(app, room, sender.id);
    tell(app, room, `This room is now shared with ${peerHost(sender)}.`);
    backfill(app, room, sender);
    return;
  }
  if (s.host !== peerHost(sender)) throw refusal(403, "Only a room's home offers it.");
  const g = /** @type {string} */ (ev.room);
  let share = offerOf(app, sender.id, g);
  if (share?.getString("state") === "active") return;
  if (!share) {
    share = new Record(app.findCollectionByNameOrId("fed_shares"));
    share.set("peer", sender.id);
    share.set("remote_id", g);
    share.set("state", "offered");
    share.set("accepted", false);
  }
  share.set("name", tidy(String(ev.name || "")).slice(0, 255));
  share.set("kind", ev.kind === "dm" ? "dm" : "public");
  share.set("visibility", ["public", "private", "open"].includes(ev.visibility) ? ev.visibility : "public");
  app.save(share);
}

/**
 * An `unshare` event: the peer ended a share, or declined or withdrew an offer.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyUnshare(app, sender, ev) {
  const s = splitGid(ev.room);
  if (!s) return;
  /** @type {core.Record | null} */
  let share = null;
  if (s.host === myHost()) {
    share = shareOf(app, s.id, sender.id);
  } else if (s.host === peerHost(sender)) {
    share = offerOf(app, sender.id, /** @type {string} */ (ev.room));
  }
  if (!share) return;
  if (share.getString("state") === "offered") {
    if (share.getString("remote_id"))
      app.delete(share); // withdrawn
    else {
      share.set("state", "ended"); // declined
      share.set("last_error", "Declined.");
      app.save(share);
    }
    return;
  }
  endShare(app, share, false);
}

/**
 * A mirror's name: the home's plus the label ("general (A)"), numbered when that is taken, within rooms.name's 48.
 * @param {core.App} app
 * @param {string} name
 * @param {string} label
 * @param {string} selfId
 */
function mirrorName(app, name, label, selfId) {
  for (let n = 1; n < 1000; n++) {
    const tail = `${n > 1 ? ` ${n}` : ""} (${label})`;
    const base =
      [...stripHashes(tidy(name))]
        .slice(0, ROOM_NAME_MAX - tail.length)
        .join("")
        .trim() || "room";
    const candidate = `${base}${tail}`;
    try {
      app.findFirstRecordByFilter("rooms", "name_key = {:k} && id != {:id}", { k: nameKey(candidate), id: selfId });
    } catch {
      return candidate;
    }
  }
  throw new Error("no free room name");
}

/**
 * A `room` event from a home: make the mirror (once its share is accepted, or a DM is opened) or bring it up to date.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyRoom(app, sender, ev) {
  const g = String(ev.room || "");
  if (splitGid(g)?.host !== peerHost(sender)) throw refusal(403, "Only a room's home sends it.");
  const dm = ev.kind === "dm";
  let share = offerOf(app, sender.id, g);
  if (!share) {
    if (!dm) return; // not offered, or ended here
    if (!sender.getBool("dms")) throw refusal(403, "Direct messages with your people are off here.");
    share = new Record(app.findCollectionByNameOrId("fed_shares"));
    share.set("peer", sender.id);
    share.set("remote_id", g);
    share.set("state", "offered");
    share.set("accepted", true);
    share.set("kind", "dm");
    share.set("visibility", "private");
  }
  if (!share.getBool("accepted")) return; // its admin hasn't taken it yet
  const people = ev.people && typeof ev.people === "object" ? ev.people : {};
  const map = (/** @type {unknown} */ list) =>
    (Array.isArray(list) ? list : [])
      .slice(0, MAX_MEMBERS)
      .map((x) => userOf(app, sender, x, people))
      .filter(Boolean);
  // Its creator is one of the home's own people: one of ours would get a creator's rights over the copy.
  const creator = userOf(app, sender, ev.created_by, people, true);
  if (!creator) throw refusal(400, "The room's creator is unknown.");
  const members = map(ev.members);
  const writers = map(ev.writers);
  const hosts = (Array.isArray(ev.shared_with) ? ev.shared_with : []).map(String).filter((/** @type {string} */ h) => h && h !== myHost());
  const shared = { home: peerHost(sender), with: [...new Set([peerHost(sender), ...hosts])] };

  let room = findRoom(app, share.getString("room"));
  const name = tidy(String(ev.name || "")).slice(0, 255);
  if (!room) {
    room = new Record(app.findCollectionByNameOrId("rooms"));
    room.set("id", newId());
    room.set("kind", dm ? "dm" : "public");
    room.set("created_by", creator);
    room.set("peer", sender.id);
    room.set("remote_id", g);
    if (dm) {
      const pair = [...members].sort();
      // One of the home's people and one of ours: a home doesn't open DMs between two people here.
      const own = (/** @type {unknown} */ g) => splitGid(g)?.host === peerHost(sender);
      const gids = Array.isArray(ev.members) ? ev.members : [];
      const ours = (/** @type {unknown} */ g) => splitGid(g)?.host === myHost();
      if (pair.length !== 2 || gids.length !== 2 || !gids.some(own) || !gids.some(ours)) {
        throw refusal(400, "A DM is between one of your people and one of ours.");
      }
      room.set("dm_key", pair.join(":"));
      try {
        app.findFirstRecordByFilter("rooms", "dm_key = {:k}", { k: pair.join(":") });
        throw refusal(409, "These two already have a DM here.");
      } catch (err) {
        if (/** @type {any} */ (err)?.status === 409) throw err;
      }
    } else {
      room.set("name", mirrorName(app, name, sender.getString("label"), room.id));
    }
  } else if (!dm && name && name !== share.getString("name")) {
    room.set("name", mirrorName(app, name, sender.getString("label"), room.id));
  }
  share.set("name", name);
  if (!dm) {
    room.set("visibility", ["public", "private", "open"].includes(ev.visibility) ? ev.visibility : "public");
    room.set("posting", ev.posting === "selected" ? "selected" : "everyone");
    room.set("archived", !!ev.archived);
    room.set("writers", writers);
  }
  room.set("members", members);
  const down = jsonOf(room, "shared", {}).down;
  room.set("shared", down ? { ...shared, down: true } : shared);
  app.save(room);
  const wasActive = share.getString("state") === "active";
  share.set("room", room.id);
  share.set("state", "active");
  share.set("last_error", ev.refused ? String(ev.refused).slice(0, 1000) : "");
  app.save(share);
  if (!wasActive && !dm) tell(app, room, `This room is shared from ${peerHost(sender)}.`);
}

// ---------------------------------------------------------------- a mirror's superuser and its members

/**
 * rooms update request on a mirror (§33.5): its state is the home's. Its superusers may rename it here, and in a
 * private room add or remove their own people, which goes to the home as a `members` request. Returns that request,
 * to send once saved (null when there is none).
 * @param {core.RecordRequestEvent} e
 * @returns {{ add: string[], remove: string[] } | null}
 */
function checkMirrorEdit(e) {
  const rec = e.record;
  if (!rec || !isMirror(rec)) return null;
  const orig = rec.original();
  const home = peerById(e.app, orig.getString("peer"));
  const where = home ? peerHost(home) : "its home";
  if (!e.hasSuperuserAuth()) throw new ForbiddenError(`This room is shared from ${where}; it is changed there.`);
  for (const f of ["kind", "visibility", "posting", "writers", "archived", "created_by", "dm_key", "peer", "remote_id", "shared"]) {
    if (fieldValue(rec, f) !== fieldValue(orig, f)) throw fieldError(f, `This room is shared from ${where}; this is changed there.`);
  }
  const was = orig.getStringSlice("members");
  const now = rec.getStringSlice("members");
  if (was.join(",") === now.join(",")) return null;
  if (orig.getString("kind") !== "public" || orig.getString("visibility") !== "private") {
    throw fieldError("members", "Only a private room's members are listed.");
  }
  const add = now.filter((id) => !was.includes(id));
  const remove = was.filter((id) => !now.includes(id));
  for (const id of [...add, ...remove]) {
    if (standInRow(e.app, id) || id === orig.getString("created_by")) {
      throw fieldError("members", `People from other instances are added and removed on ${where}.`);
    }
  }
  return { add, remove };
}

/**
 * rooms update request on a mirror (saved): send its superuser's member change to the home.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {{ add: string[], remove: string[] }} change
 */
function sendMembers(app, room, change) {
  const peer = peerById(app, room.getString("peer"));
  if (!peer) return;
  enqueue(app, peer.id, {
    type: "members",
    room: room.getString("remote_id"),
    add: change.add.map((id) => gid(id)),
    remove: change.remove.map((id) => gid(id)),
    people: peopleFor(app, peer, change.add),
  });
}

/**
 * Before a room is deleted for good (a superuser): the peers to tell, as [peer id, room global id].
 * @param {core.App} app
 * @param {core.Record} room
 * @returns {string[][]}
 */
function peersToTell(app, room) {
  if (isMirror(room)) {
    const share = app.findRecordsByFilter("fed_shares", "room = {:r} && state = 'active'", "", 1, 0, { r: room.id })[0];
    return share ? [[share.getString("peer"), room.getString("remote_id")]] : [];
  }
  return sharesOf(app, room.id, ["offered", "active"]).map((s) => [s.getString("peer"), gid(room.id)]);
}

/**
 * A room deleted for good: its shares went with it; the peers hear that they ended.
 * @param {core.App} app
 * @param {core.Record} _room
 * @param {string[][]} peers peersToTell
 */
function tellDeleted(app, _room, peers) {
  for (const [peerId, g] of peers) enqueue(app, peerId, { type: "unshare", room: g });
}

/**
 * The rooms of a peer that can't be reached (suspended here, or not answering) say so in their header (§33.7).
 * @param {core.App} app
 * @param {string} peerId
 * @param {boolean} down
 */
function setDown(app, peerId, down) {
  for (const room of app.findRecordsByFilter("rooms", "peer = {:p}", "", 0, 0, { p: peerId })) {
    if (!room) continue;
    const shared = jsonOf(room, "shared", {});
    if (!!shared.down === down || !shared.home) continue;
    if (down) shared.down = true;
    else delete shared.down;
    room.set("shared", shared);
    app.save(room);
  }
}

module.exports = {
  refusal,
  isMirror,
  roomGid,
  roomFor,
  sharesOf,
  stateOf,
  roomChanged,
  roomCreated,
  refreshShared,
  checkHomeMembers,
  applyMembers,
  endShare,
  beforeOffer,
  afterOffer,
  beforeShareEdit,
  afterShareEdit,
  beforeShareDelete,
  applyShare,
  applyUnshare,
  applyRoom,
  checkMirrorEdit,
  sendMembers,
  setDown,
  peersToTell,
  tellDeleted,
};
