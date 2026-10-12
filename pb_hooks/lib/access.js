/// <reference path="../../types/pocketbase.d.ts" />
// Room access (DESIGN.md §23): who can see a room, the way the rooms view rule says it (pb_migrations/
// 1760000014_room_access.js; keep the two in sync). For hooks and routes that check a room themselves, and for telling
// realtime clients about a room they can no longer see.

/** Most members a private room can have (rooms.members maxSelect). */
const MAX_MEMBERS = 100;

/**
 * What decides who can see a room, copied out of the record (so a hook can keep it from before a save).
 * @typedef {{ id: string, visibility: string, archived: boolean, createdBy: string, members: string[] }} Access
 */

/**
 * @param {core.Record} room
 * @returns {Access}
 */
function accessOf(room) {
  return {
    id: room.id,
    visibility: room.getString("visibility"),
    archived: room.getBool("archived"),
    createdBy: room.getString("created_by"),
    members: room.getStringSlice("members"),
  };
}

/**
 * Can `userId` ("" for a guest) see the room? Open Air rooms that aren't archived: anyone. Otherwise only signed in:
 * any public room, or a private one (DMs too) they are a member or the creator of.
 * @param {Access} a
 * @param {string} userId
 */
function canSee(a, userId) {
  if (a.visibility === "open" && !a.archived) return true;
  if (!userId) return false;
  return a.visibility !== "private" || a.createdBy === userId || a.members.includes(userId);
}

/**
 * The room if `userId` can see it, else null (also for a room that doesn't exist).
 * @param {core.App} app
 * @param {string} roomId
 * @param {string} userId
 */
function visibleRoom(app, roomId, userId) {
  let room;
  try {
    room = app.findRecordById("rooms", roomId);
  } catch {
    return null;
  }
  return canSee(accessOf(room), userId) ? room : null;
}

/**
 * After a room changed (§23.4): every realtime client that could see it before but can't now gets a `delete` event
 * for it on its rooms subscriptions. PocketBase only sends a change to those who can see the result, so otherwise
 * they would never hear of it: a member taken out of a private room would keep it in their list, and a guest an Open
 * Air room that was archived or made private. Only the id goes out.
 * @param {core.App} app
 * @param {Access} before
 * @param {core.Record} room
 */
function dropLostAccess(app, before, room) {
  const after = accessOf(room);
  // Most saves don't touch access (every DM message saves its room): then there is no one to tell (QA BUG-63).
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const data = JSON.stringify({ action: "delete", record: { id: room.id } });
  const clients = app.subscriptionsBroker().clients();
  for (const id of Object.keys(clients)) {
    const client = clients[id];
    if (!client || client.isDiscarded()) continue;
    /** @type {core.Record | null | undefined} */
    const auth = client.get("auth");
    if (auth?.isSuperuser()) continue;
    const userId = auth ? auth.id : "";
    if (!canSee(before, userId) || canSee(after, userId)) continue;
    for (const name of Object.keys(client.subscriptions("rooms"))) client.send(new SubscriptionMessage({ name, data }));
  }
}

module.exports = { MAX_MEMBERS, accessOf, canSee, visibleRoom, dropLostAccess };
