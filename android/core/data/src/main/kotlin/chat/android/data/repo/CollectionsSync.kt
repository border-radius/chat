// Media collections (DESIGN.md §31): web/src/collections.ts. Keeps `collections` in the store (yours, and the public
// ones you follow with how many of their items are new) for as long as someone is logged in, refetched whenever one of
// them or your subscriptions change (live), and on every reconnect. Screens read the store; what changes a collection
// calls refresh() after.
package chat.android.data.repo

import chat.android.data.api.ChatApi
import chat.android.data.pb.Unsubscribe
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class CollectionsSync(private val api: ChatApi, private val store: Store, private val main: CoroutineDispatcher) {
    private var run: Run? = null
    private var timer: Job? = null
    private var issued = 0
    /** The live subscription, for the collections followed when it was made. */
    private var live: Pair<String, Job>? = null

    fun start() {
        if (run != null) return
        val r = Run(null, main)
        run = r
        r.scope.launch {
            launch { api.connects.collect { reconnect -> if (reconnect) load(r) } }
            load(r)
        }
    }

    fun stop() {
        run?.dispose()
        run = null
        live = null
        timer = null
    }

    /** Refetch soon (several calls in a row make one request). */
    fun refresh() {
        val r = run ?: return
        timer?.cancel()
        timer = r.scope.launch {
            delay(REFRESH_MS)
            load(r)
        }
    }

    /** Refetch now, and wait for it (a screen that needs the new list, e.g. after subscribing). */
    suspend fun reload() {
        run?.let { load(it) }
    }

    /** You have seen the collection up to [at] (its newest item's `created`): its badge goes at once. */
    fun seen(id: String, at: String = "") {
        val c = store.get().collections
        if (c != null && c.subs.any { it.id == id && it.new > 0 }) {
            store.update { s -> s.copy(collections = c.copy(subs = c.subs.map { if (it.id == id) it.copy(new = 0) else it })) }
        }
        val r = run ?: return
        r.scope.launch { runCatching { api.markSeen(id, at) } }
    }

    private suspend fun load(r: Run) {
        val seq = ++issued
        val res = runCatching { api.collections() }.getOrNull()
        if (res == null || !r.active || seq != issued) return
        store.update { it.copy(collections = res) }
        follow(r)
    }

    /** Listen to your collections and those you follow (again, when they changed). */
    private fun follow(r: Run) {
        val ids = store.get().collections?.subs?.map { it.id }.orEmpty()
        val key = ids.joinToString(",")
        if (live?.first == key) return
        live?.second?.cancel()
        var off: Unsubscribe? = null
        lateinit var job: Job
        job = r.scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            try {
                off = api.subscribeCollections(ids) { r.post { refresh() } }
                kotlinx.coroutines.awaitCancellation()
            } catch (e: chat.android.data.api.ApiError) {
                // Not subscribed: the next load tries again.
                if (live?.second === job) live = null
            } finally {
                off?.let { Run.cleanup(it) }
            }
        }
        live = key to job
        job.start()
    }

    private companion object {
        const val REFRESH_MS = 250L
    }
}
