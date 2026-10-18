/// <reference path="../../types/pocketbase.d.ts" />
// Telegram → chat (DESIGN.md §26.4): updates from the webhook, or from polling in development. A Telegram message
// becomes a chat message of its sender's stand-in, with its files; an album (sent as one update per item) becomes one
// message once all of it is in; an edit edits it. Telegram doesn't tell bots about deleted messages.

const { call, config, download } = require(`${__hooks}/telegram/api.js`);
const { personOf } = require(`${__hooks}/telegram/people.js`);
const { activeLink, ensureLink, linkedRoom, linkOfChat, moveLink, tellLinkChange } = require(`${__hooks}/telegram/links.js`);

/** The largest file the Bot API lets a bot download, and the largest attachment (§17.1). */
const MAX_FILE = 20 * 1024 * 1024;
/** messages.files maxSelect and messages.text max. */
const MAX_FILES = 10;
const MAX_TEXT = 2000;
/** An album is complete when nothing more of it came for this long. */
const ALBUM_QUIET_MS = 1500;

const mb = (/** @type {number} */ n) => `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;

/**
 * "Forwarded from Bob", when the Telegram message is a forward.
 * @param {any} msg
 */
function forwardLine(msg) {
  const o = msg.forward_origin;
  if (!o) return "";
  const from =
    o.type === "user"
      ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ")
      : o.type === "hidden_user"
        ? o.sender_user_name
        : o.type === "chat"
          ? o.sender_chat.title
          : o.type === "channel"
            ? o.chat.title
            : "";
  return `↪ Forwarded from ${from || "someone"}`;
}

/**
 * A Telegram message's files (that can be brought over), and lines for what can't be: files over the download limit,
 * and things that aren't files (a location, a poll…).
 * @param {any} msg
 * @returns {{ files: { id: string, name: string }[], notes: string[] }}
 */
function partsOf(msg) {
  /** @type {{ id: string, name: string }[]} */
  const files = [];
  /** @type {string[]} */
  const notes = [];
  const n = msg.message_id;
  /**
   * @param {any} f
   * @param {string} name
   */
  const add = (f, name) => {
    if (f.file_size && f.file_size > MAX_FILE) notes.push(`[${name}, ${mb(f.file_size)}: too large to bring over from Telegram]`);
    else files.push({ id: f.file_id, name });
  };
  if (msg.photo?.length) add(msg.photo[msg.photo.length - 1], `photo_${n}.jpg`);
  if (msg.video) add(msg.video, msg.video.file_name || `video_${n}.mp4`);
  // A GIF comes as an animation, with a document of the same file next to it.
  if (msg.animation) add(msg.animation, msg.animation.file_name || `animation_${n}.mp4`);
  else if (msg.document) add(msg.document, msg.document.file_name || `file_${n}`);
  if (msg.audio) add(msg.audio, msg.audio.file_name || `audio_${n}.mp3`);
  if (msg.voice) add(msg.voice, `voice_${n}.ogg`);
  if (msg.video_note) add(msg.video_note, `video_note_${n}.mp4`);
  if (msg.sticker) {
    if (msg.sticker.is_animated) notes.push(`[sticker ${msg.sticker.emoji || ""}]`.replace(" ]", "]"));
    else add(msg.sticker, `sticker_${n}.${msg.sticker.is_video ? "webm" : "webp"}`);
  }
  const loc = msg.venue ? msg.venue.location : msg.location;
  if (loc) {
    const where = `https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}`;
    notes.push(msg.venue ? `[${msg.venue.title}, ${msg.venue.address}: ${where}]` : `[location: ${where}]`);
  }
  if (msg.contact)
    notes.push(`[contact: ${[msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(" ")} ${msg.contact.phone_number}]`);
  if (msg.poll) notes.push(`[poll: ${msg.poll.question}]`);
  if (msg.dice) notes.push(`[${msg.dice.emoji} ${msg.dice.value}]`);
  return { files, notes };
}

/**
 * Text cut to messages.text's limit (in code points, as PocketBase counts).
 * @param {string} text
 */
function clip(text) {
  const chars = [...text];
  return chars.length <= MAX_TEXT ? text : `${chars.slice(0, MAX_TEXT - 1).join("")}…`;
}

/**
 * The chat message a Telegram message is (either way), or null.
 * @param {core.App} app
 * @param {string} chatId
 * @param {number} tgId
 */
function mapped(app, chatId, tgId) {
  try {
    const row = app.findFirstRecordByFilter("tg_messages", "chat_id = {:chat} && tg_message_id = {:id}", { chat: chatId, id: tgId });
    return app.findRecordById("messages", row.getString("message"));
  } catch {
    return null;
  }
}

/**
 * Stand-ins write in a private room as members, and in a room where only some people post as writers (the messages
 * hook checks both, §23, §23.6): the Telegram group decides who speaks.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} userId
 */
function ensureMember(app, room, userId) {
  if (room.getString("created_by") === userId) return;
  const members = room.getStringSlice("members");
  const writers = room.getStringSlice("writers");
  const member = room.getString("visibility") !== "private" || members.includes(userId);
  const writer = room.getString("posting") !== "selected" || writers.includes(userId);
  if (member && writer) return;
  if (!member) room.set("members", [...members, userId]);
  if (!writer) room.set("writers", [...writers, userId]);
  app.save(room);
}

/**
 * Bring Telegram messages over as one chat message: one message, or the items of an album.
 * @param {core.App} app
 * @param {core.Record} link tg_links
 * @param {core.Record} room
 * @param {any[]} msgs
 */
function bringOver(app, link, room, msgs) {
  const chatId = link.getString("chat_id");
  msgs = msgs.filter((m) => !mapped(app, chatId, m.message_id)); // delivered twice (a webhook retry)
  if (!msgs.length) return;
  msgs.sort((a, b) => a.message_id - b.message_id);
  const first = msgs[0];
  const parts = msgs.map(partsOf);
  const notes = parts.flatMap((p) => p.notes);
  // A service message (a new group photo, a timer, a topic…) has nothing to show: it makes no stand-in, and none joins
  // a private room for it (QA BUG-88).
  if (!notes.length && !parts.some((p) => p.files.length) && !msgs.some((m) => (m.text || m.caption || "").trim())) return;
  const author = personOf(app, first);
  ensureMember(app, room, author.id);

  /** @type {any[]} */
  const files = [];
  for (const f of parts.flatMap((p) => p.files)) {
    if (files.length >= MAX_FILES) {
      notes.push(`[${f.name}: more files than a message holds]`);
      continue;
    }
    try {
      files.push(download(f.id, f.name));
    } catch (err) {
      app.logger().warn("telegram: download", "chat", chatId, "error", String(err));
      notes.push(`[${f.name}: couldn't be brought over from Telegram]`);
    }
  }
  const lines = [forwardLine(first), ...msgs.map((m) => m.text || m.caption || ""), ...notes].filter(Boolean);
  const text = clip(lines.join("\n"));
  if (!text.trim() && !files.length) return;

  const reply = first.reply_to_message ? mapped(app, chatId, first.reply_to_message.message_id) : null;
  // The message and what it maps to in one transaction: the outbound hook queues it for the room's other linked
  // groups, and the worker must find it came from this one (outbound.js), never send it back.
  const save = (/** @type {boolean} */ withReply) =>
    app.runInTransaction((tx) => {
      const rec = new Record(tx.findCollectionByNameOrId("messages"));
      rec.set("room", room.id);
      rec.set("author", author.id);
      rec.set("text", text);
      if (files.length) rec.set("files", files);
      if (withReply && reply && reply.getString("room") === room.id && !reply.getBool("deleted")) rec.set("reply_to", reply.id);
      tx.save(rec);
      msgs.forEach((m, i) => {
        const row = new Record(tx.findCollectionByNameOrId("tg_messages"));
        row.set("message", rec.id);
        row.set("chat_id", chatId);
        row.set("tg_message_id", m.message_id);
        row.set("direction", "in");
        row.set("kind", i === 0 ? "text" : "media");
        tx.save(row);
      });
    });
  try {
    save(true);
  } catch (err) {
    if (!reply) throw err;
    save(false); // the quoted message went meanwhile: without the quote, as the app does (§19)
  }
}

/**
 * A Telegram edit: the chat message gets the new text.
 * @param {core.App} app
 * @param {any} msg
 */
function editOver(app, msg) {
  const rec = mapped(app, String(msg.chat.id), msg.message_id);
  if (!rec || rec.getBool("deleted") || rec.getString("forwarded_from")) return;
  const lines = [forwardLine(msg), msg.text || msg.caption || "", ...partsOf(msg).notes].filter(Boolean);
  const text = clip(lines.join("\n"));
  if (text === rec.getString("text") || (!text.trim() && !rec.getStringSlice("files").length)) return;
  rec.set("text", text);
  app.save(rec);
}

/**
 * Queue an album's item: the album becomes one message when it is complete (flushAlbums).
 * @param {core.App} app
 * @param {any} msg
 */
function queueAlbumItem(app, msg) {
  const row = new Record(app.findCollectionByNameOrId("tg_queue"));
  row.set("op", "album");
  row.set("chat_id", String(msg.chat.id));
  row.set("album", msg.media_group_id);
  row.set("payload", msg);
  app.save(row);
}

/**
 * Take an album's queued items, so only one caller brings it over.
 * @param {core.App} app
 * @param {string} chatId
 * @param {string} album
 * @returns {any[]} its Telegram messages
 */
function takeAlbum(app, chatId, album) {
  /** @type {any[]} */
  const msgs = [];
  app.runInTransaction((tx) => {
    const rows = tx.findRecordsByFilter("tg_queue", "op = 'album' && chat_id = {:chat} && album = {:album}", "created", 0, 0, {
      chat: chatId,
      album,
    });
    for (const row of rows) {
      if (!row) continue;
      msgs.push(JSON.parse(row.getString("payload") || "null"));
      tx.delete(row);
    }
  });
  return msgs.filter(Boolean);
}

/**
 * Bring over queued albums: those of `chatId` except `except` (something else came after them, so they are complete),
 * or with no chat given, those quiet for ALBUM_QUIET_MS or full.
 * @param {core.App} app
 * @param {string} [chatId]
 * @param {string} [except]
 */
function flushAlbums(app, chatId, except) {
  const rows = chatId
    ? app.findRecordsByFilter("tg_queue", "op = 'album' && chat_id = {:chat}", "created", 0, 0, { chat: chatId })
    : app.findRecordsByFilter("tg_queue", "op = 'album'", "created", 0, 0);
  /** @type {Map<string, { chat: string, album: string, last: number, count: number }>} */
  const groups = new Map();
  for (const row of rows) {
    if (!row) continue;
    const key = `${row.getString("chat_id")} ${row.getString("album")}`;
    const g = groups.get(key) || { chat: row.getString("chat_id"), album: row.getString("album"), last: 0, count: 0 };
    g.last = Math.max(g.last, row.getDateTime("created").time().unixMilli());
    g.count++;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (chatId ? g.album === except : g.count < MAX_FILES && Date.now() - g.last < ALBUM_QUIET_MS) continue;
    const msgs = takeAlbum(app, g.chat, g.album);
    const link = linkOfChat(app, g.chat);
    const room = link && activeLink(app, link);
    if (!msgs.length || !link || !room) continue;
    try {
      bringOver(app, link, room, msgs);
    } catch (err) {
      app.logger().error("telegram: album", "chat", g.chat, "error", String(err));
    }
  }
}

/** /chatid or /start, maybe addressed to the bot ("/chatid@my_bot"). */
const COMMAND = /^\/(chatid|start)(@\w+)?(\s|$)/;

/**
 * Tell a group its id and whether it is linked: what a superuser needs to link it in the admin UI.
 * @param {core.App} app
 * @param {string} chatId
 */
function sayStatus(app, chatId) {
  const link = linkOfChat(app, chatId);
  const room = link && activeLink(app, link);
  const text = room
    ? `This group is linked to the chat room "${room.getString("name")}". Chat id: ${chatId}`
    : `This group isn't linked to a chat room yet. Chat id: ${chatId}\nAn admin of the chat links it in the admin UI (collection tg_links).`;
  call("sendMessage", { chat_id: chatId, text });
}

/**
 * Handle one update, from the webhook or polling.
 * @param {core.App} app
 * @param {any} update
 */
function handleUpdate(app, update) {
  if (update.my_chat_member) return memberChange(app, update.my_chat_member);
  const msg = update.message || update.edited_message;
  if (!msg?.chat) return;
  const chatId = String(msg.chat.id);
  if (msg.chat.type === "private") {
    if (update.message)
      call("sendMessage", { chat_id: chatId, text: "I bring messages between Telegram groups and chat rooms. Add me to a group." });
    return;
  }
  // A group that became a supergroup: Telegram says so in both, in either order (QA BUG-89).
  if (msg.migrate_to_chat_id) return moveLink(app, chatId, String(msg.migrate_to_chat_id));
  if (msg.migrate_from_chat_id) return moveLink(app, String(msg.migrate_from_chat_id), chatId);
  const link = ensureLink(app, msg.chat);
  if (update.message && COMMAND.test(msg.text || "")) return sayStatus(app, chatId);
  const room = activeLink(app, link);
  if (!room) return;
  if (update.message && msg.media_group_id) {
    flushAlbums(app, chatId, msg.media_group_id);
    queueAlbumItem(app, msg);
    return;
  }
  flushAlbums(app, chatId); // what came before this must show before it
  if (update.edited_message) editOver(app, msg);
  else if (!msg.new_chat_members && !msg.left_chat_member && !msg.pinned_message && !msg.new_chat_title) bringOver(app, link, room, [msg]);
}

/**
 * The bot was added to a group, or removed from it.
 * @param {core.App} app
 * @param {any} change
 */
function memberChange(app, change) {
  if (change.chat.type === "private") return;
  const status = change.new_chat_member?.status;
  const link = ensureLink(app, change.chat);
  if (status === "left" || status === "kicked") {
    app.runInTransaction((tx) => {
      // Read again in the transaction: the same news twice at once must tell the room once.
      const fresh = tx.findRecordById("tg_links", link.id);
      const was = linkedRoom(fresh);
      if (!was) return;
      fresh.set("enabled", false);
      // Past the tg_links hooks, which would tell the room it was disconnected without saying why.
      tx.unsafeWithoutHooks().save(fresh);
      tellLinkChange(tx, fresh, was, "", ": the bot was removed from the group");
    });
    return;
  }
  const was = change.old_chat_member?.status;
  if ((status === "member" || status === "administrator") && (was === "left" || was === "kicked")) sayStatus(app, String(change.chat.id));
}

/**
 * POST /api/telegram/webhook: an update from Telegram, which signs it with the secret given to setWebhook. Always
 * answers 200 once the secret is right: Telegram would retry a failed update, and one that can't be handled
 * (logged) shouldn't block the ones after it.
 * @param {core.RequestEvent} e
 */
function webhook(e) {
  const given = e.request ? e.request.header.get("X-Telegram-Bot-Api-Secret-Token") : "";
  if (!$security.equal(given, config().secret)) throw new UnauthorizedError("Wrong secret."); // in constant time (QA BUG-91)
  const update = e.requestInfo().body;
  try {
    handleUpdate(e.app, update);
  } catch (err) {
    e.app.logger().error("telegram: update", "update", update?.update_id, "error", String(err));
  }
  return e.json(200, { ok: true });
}

module.exports = { webhook, handleUpdate, flushAlbums };
