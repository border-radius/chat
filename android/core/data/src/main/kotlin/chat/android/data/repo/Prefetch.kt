// Keeps the room cache filled (ANDROID.md §6.3; web/src/prefetch.ts): once the room list and counts are in, the latest
// page of each room with unread messages, then of the first rooms not kept yet, one at a time. Unlike the web, a new
// message in a room that isn't open never fetches its page: every phone would ask at once (the herd of QA BUG-108).
// Its page comes at launch, after a reconnect, with a push, or when the room opens. A delete does fetch it again, so the
// cache never shows the deleted text.
package chat.android.data.repo

import chat.android.data.api.ChatApi
import chat.android.data.lib.PAGE_SIZE
import chat.android.data.lib.Pages
import chat.android.data.lib.roomSections
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class Prefetch(
    private val api: ChatApi,
    private val store: Store,
    private val cache: RoomCache,
    private val main: CoroutineDispatcher,
    private val gapMs: Long = 250,
) {
    private var run: Run? = null
    private val due = LinkedHashSet<String>()
    private val cold = LinkedHashSet<String>()
    private var draining: Job? = null

    fun start() {
        val user = store.get().user?.id ?: return
        if (run != null) return
        val r = Run(null, main)
        run = r
        due.clear()
        cold.clear()
        var warmed = false
        val warm = { s: AppState ->
            if (!warmed && s.roomsStatus == LoadStatus.Ready && s.counted) {
                warmed = true
                dueUnread(s)
                val sections = roomSections(s.rooms.values, s.hidden.keys, user, s.activeRoomId, s.unread)
                for (room in (sections.dms + sections.rooms).take(WARM)) cold += room.id
                drain(r, user)
            }
        }
        r.defer(store.listen { s, _ -> warm(s) })
        warm(store.get())
        r.sub { api.subscribeAllMessages { c -> if (c.record.deleted) r.post { add(r, user, c.record.room) } } }
        r.scope.launch {
            api.connects.collect { reconnect ->
                if (!reconnect) return@collect
                // The counts are reloaded after a reconnect; wait for them, then fetch the rooms they say have news.
                delay(RECONNECT_DELAY_MS)
                dueUnread(store.get())
                drain(r, user)
            }
        }
    }

    fun stop() {
        run?.dispose()
        run = null
        draining = null
    }

    /** Rooms whose unread messages the cache doesn't have yet. */
    private fun dueUnread(s: AppState) {
        val user = s.user?.id ?: return
        for ((id, n) in s.unread) if (n > 0 && id != s.activeRoomId && s.rooms[id]?.archived != true && id !in s.hidden && cache.peek(user, id)?.unread != n) due += id
    }

    private fun add(r: Run, user: String, room: String) {
        if (room == store.get().activeRoomId) return
        due += room
        drain(r, user)
    }

    private fun drain(r: Run, user: String) {
        if (draining?.isActive == true) return
        draining = r.scope.launch {
            while (true) {
                val id = due.firstOrNull()?.also { due -= it; cold -= it } ?: cold.firstOrNull()?.also { cold -= it } ?: break
                val fromCold = id !in store.get().unread
                if (id == store.get().activeRoomId) continue
                if (fromCold && cache.get(user, id) != null) continue
                fetch(user, id) ?: run {
                    // Refused (the rate limit, offline): the rest waits for the next reconnect or launch.
                    due.clear()
                    cold.clear()
                    return@launch
                }
                delay(gapMs)
            }
        }
    }

    /** Fetch a room's latest page into the cache now (a push, ANDROID.md §8.3). Null when it failed. */
    suspend fun fetch(user: String, id: String): Unit? {
        val unread = store.get().unread[id]
        val page = runCatching { api.page(Pages.latest(id)) }.getOrNull() ?: return null
        // The open room keeps its own page (and gets every message live).
        if (store.get().user?.id == user && store.get().activeRoomId != id) {
            cache.put(user, id, Kept(page.reversed(), page.size >= PAGE_SIZE, store.get().rooms[id], unread))
        }
        return Unit
    }

    private companion object {
        /** Rooms not kept yet that are fetched once the list is in: the first ones it lists (DMs, then rooms). */
        const val WARM = 30
        const val RECONNECT_DELAY_MS = 1500L
    }
}
