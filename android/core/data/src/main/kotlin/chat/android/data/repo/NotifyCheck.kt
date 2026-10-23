// Notifications without Google (ANDROID.md §8): WorkManager runs a check about every 15 minutes, and it asks each
// account's server what is new for you: DMs and replies to your messages, unread, not hidden, not archived, not
// notified before. Rooms with nothing unread are never queried: the unread counts (one request) say which to ask.
package chat.android.data.repo

import chat.android.data.api.ChatApi
import chat.android.data.db.ChatDatabase
import chat.android.data.db.Keys
import chat.android.data.db.KvEntity
import chat.android.data.lib.parsePb
import chat.android.data.lib.toPb
import chat.android.data.model.Message
import chat.android.data.model.Room
import chat.android.data.pb.PbJson
import kotlinx.serialization.Serializable

/** One room's news: its new messages, oldest first, and its unread count (the badge). */
data class Notice(val room: Room, val messages: List<Message>, val unread: Int)

/** What a check found. [unreadRooms]: the rooms with unread messages; a notification of any other is stale. */
data class CheckResult(val notices: List<Notice>, val unreadRooms: Set<String>)

/**
 * [at]: the server's time of the last check. [ids]: what it saw, so the overlap isn't notified twice. [from]: when the
 * session began: nothing older is news.
 */
@Serializable
private data class CheckState(val at: String, val ids: List<String> = emptyList(), val from: String = "")

class NotifyCheck(private val api: ChatApi, private val db: ChatDatabase) {
    /** At sign-in: news starts now, not with what was there before. A check already begun is kept. */
    suspend fun begin() {
        if (api.currentUser() != null && db.kv().get(Keys.NOTIFY_CHECK) == null) api.unreadCounts().at.let { save(CheckState(it, from = it)) }
    }

    /**
     * Check for news since the last check. [quiet]: the app is on screen with this account, so nothing is notified
     * (the room list shows it) but it counts as seen. [openRoom]: the room on screen, never notified.
     * Null without a session.
     */
    suspend fun run(quiet: Boolean = false, openRoom: String? = null): CheckResult? {
        if (api.currentUser() == null) return null
        val counts = api.unreadCounts()
        val unreadRooms = counts.rooms.filterValues { it > 0 }.keys
        val state = load()
        if (state == null || quiet || unreadRooms.isEmpty()) {
            // Not begun, or seen on screen: nothing until now is news.
            save(CheckState(counts.at, from = if (state == null || quiet) counts.at else state.from))
            return CheckResult(emptyList(), unreadRooms)
        }
        // A message's `created` says nothing about when it was committed (QA BUG-106): look back a little further,
        // and skip what the last check already saw.
        val since = maxOf(toPb(parsePb(state.at) - OVERLAP_MS), state.from)
        val fetched = unreadRooms.toList().chunked(CHUNK).flatMap { api.notifiable(it, since) }
        save(CheckState(counts.at, fetched.map { it.id }.take(MAX_IDS), state.from))
        // The open room's are seen.
        val fresh = fetched.filter { it.id !in state.ids && it.room != openRoom }
        if (fresh.isEmpty()) return CheckResult(emptyList(), unreadRooms)
        val byRoom = fresh.groupBy { it.room }
        val read = api.readPositions(byRoom.keys.toList())
        val hidden = runCatching { api.listHidden().map { it.room }.toSet() }.getOrDefault(emptySet())
        val notices = byRoom.mapNotNull { (id, ms) ->
            // Hidden and archived rooms stay silent (DESIGN.md §13).
            if (id in hidden) return@mapNotNull null
            val room = runCatching { api.getRoom(id) }.getOrNull() ?: return@mapNotNull null
            if (room.archived) return@mapNotNull null
            val unread = ms.filter { it.created > read[id].orEmpty() }.sortedWith(compareBy({ it.created }, { it.id }))
            if (unread.isEmpty()) null else Notice(room, unread, counts.rooms[id] ?: unread.size)
        }
        return CheckResult(notices.sortedBy { it.messages.last().created }, unreadRooms)
    }

    /** Builds with Firebase registered a push token: the server needn't push to it any more. */
    suspend fun forgetPushToken() {
        val row = db.kv().get(Keys.PUSH_ROW)?.substringBefore(' ') ?: return
        runCatching { api.unregisterPush(row) }
        db.kv().delete(Keys.PUSH_ROW)
    }

    private suspend fun load(): CheckState? =
        db.kv().get(Keys.NOTIFY_CHECK)?.let { runCatching { PbJson.decodeFromString(CheckState.serializer(), it) }.getOrNull() }

    private suspend fun save(s: CheckState) = db.kv().put(KvEntity(Keys.NOTIFY_CHECK, PbJson.encodeToString(CheckState.serializer(), s)))

    private companion object {
        const val OVERLAP_MS = 60_000L
        /** Rooms per request: the filter stays short. */
        const val CHUNK = 40
        const val MAX_IDS = 500
    }
}
