// What the "from collection" badges of a room's files say (DESIGN.md §31.3): asked of the server once per collection
// while the room is open (so a rename or a change to private shows once it is opened again), in batches of at most 50.
package chat.android.data.repo

import chat.android.data.api.ChatApi
import chat.android.data.model.Badge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield

class Badges(private val api: ChatApi, private val scope: CoroutineScope) {
    private val known = MutableStateFlow<Map<String, Badge?>>(emptyMap())
    private val asked = mutableSetOf<String>()
    private val pending = mutableSetOf<String>()

    /** Collection id → its badge, or null for one that is gone. Absent until the server has answered. */
    val state: StateFlow<Map<String, Badge?>> = known.asStateFlow()

    /** Ask about [ids] not asked about yet (the calls of one frame make one request). */
    fun want(ids: Iterable<String>) {
        val fresh = ids.filter { it.isNotEmpty() && asked.add(it) }
        if (fresh.isEmpty()) return
        val first = pending.isEmpty()
        pending += fresh
        if (!first) return
        scope.launch {
            yield()
            val batch = pending.toList()
            pending.clear()
            for (chunk in batch.chunked(MAX)) {
                runCatching { api.badges(chunk) }
                    .onSuccess { got -> known.value = known.value + chunk.associateWith { got[it] } }
                    // Not answered: asked again with the next render that shows them.
                    .onFailure { asked -= chunk.toSet() }
            }
        }
    }

    private companion object {
        const val MAX = 50
    }
}
