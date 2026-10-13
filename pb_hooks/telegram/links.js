/// <reference path="../../types/pocketbase.d.ts" />
// Which Telegram group goes with which room (DESIGN.md §26.5, collection tg_links). A row appears, disabled and with
// no room, for every group the bot is in; a superuser links it in the admin UI by picking the room and enabling it.

const { fieldError, recordOf } = require(`${__hooks}/lib/records.js`);

/**
 * @param {core.App} app
 * @param {string} chatId
 */
function linkOfChat(app, chatId) {
  try {
    return app.findFirstRecordByFilter("tg_links", "chat_id = {:chat}", { chat: chatId });
  } catch {
    return null;
  }
}

/**
 * The room of a link that is in use: enabled, with a room that isn't archived. Null otherwise.
 * @param {core.App} app
 * @param {core.Record} link
 */
function activeLink(app, link) {
  if (!link.getBool("enabled") || !link.getString("room")) return null;
  try {
    const room = app.findRecordById("rooms", link.getString("room"));
    return room.getBool("archived") ? null : room;
  } catch {
    return null;
  }
}

/**
 * The enabled links of a room (a room may be linked to several groups).
 * @param {core.App} app
 * @param {string} roomId
 */
function linksOfRoom(app, roomId) {
  return app.findRecordsByFilter("tg_links", "room = {:room} && enabled = true", "created", 0, 0, { room: roomId }).filter((l) => !!l);
}

/**
 * The group's link, made (disabled, no room) the first time the bot hears from it; its title kept up to date.
 * @param {core.App} app
 * @param {any} chat
 */
function ensureLink(app, chat) {
  const chatId = String(chat.id);
  const title = String(chat.title || "").slice(0, 255);
  let link = linkOfChat(app, chatId);
  if (!link) {
    link = new Record(app.findCollectionByNameOrId("tg_links"));
    link.set("chat_id", chatId);
    link.set("title", title);
    link.set("enabled", false);
    try {
      app.save(link);
    } catch (err) {
      const again = linkOfChat(app, chatId); // made meanwhile (the unique index)
      if (!again) throw err;
      link = again;
    }
  } else if (title && title !== link.getString("title")) {
    link.set("title", title);
    app.save(link);
  }
  return link;
}

/**
 * A group became a supergroup, which has a new id: its link follows.
 * @param {core.App} app
 * @param {string} from
 * @param {string} to
 */
function moveLink(app, from, to) {
  const link = linkOfChat(app, from);
  if (!link || linkOfChat(app, to)) return;
  link.set("chat_id", to);
  app.save(link);
  app.db().newQuery("UPDATE tg_messages SET chat_id = {:to} WHERE chat_id = {:from}").bind({ to, from }).execute();
}

/**
 * tg_links create/update: only a room (not a DM) can be linked, and only a link with a room can be enabled.
 * @param {core.RecordEvent} e
 */
function beforeLinkSave(e) {
  const rec = recordOf(e);
  const roomId = rec.getString("room");
  if (roomId) {
    const room = e.app.findRecordById("rooms", roomId);
    if (room.getString("kind") === "dm") throw fieldError("room", "Direct messages can't be linked to Telegram.");
  }
  if (rec.getBool("enabled") && !roomId) throw fieldError("enabled", "Choose the room first.");
}

module.exports = { linkOfChat, activeLink, linksOfRoom, ensureLink, moveLink, beforeLinkSave };
