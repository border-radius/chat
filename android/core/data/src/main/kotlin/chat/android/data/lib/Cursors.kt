// Keyset pagination over a room's messages, ordered by (created, id) (DESIGN.md §6, §7.5): web/src/lib/cursor.ts.
// Pure query builders: PbClient binds `params` into the filter, never by concatenation.
package chat.android.data.lib

import chat.android.data.model.Cursor

const val PAGE_SIZE = 50

data class PageQuery(val filter: String, val params: Map<String, String>, val sort: String) {
    val descending: Boolean get() = sort.startsWith("-")
}

private const val DESC = "-created,-id"
private const val ASC = "created,id"

object Pages {
    /** The newest page of a room (newest first). */
    fun latest(room: String) = PageQuery("room = {:room}", mapOf("room" to room), DESC)

    /** The oldest page of a room (oldest first). */
    fun first(room: String) = PageQuery("room = {:room}", mapOf("room" to room), ASC)

    /** The page just before [c], the oldest loaded message (newest first). */
    fun older(room: String, c: Cursor) = PageQuery(
        "room = {:room} && (created < {:created} || (created = {:created} && id < {:id}))",
        mapOf("room" to room, "created" to c.created, "id" to c.id),
        DESC,
    )

    /** The page just after [c], the newest loaded message (oldest first). */
    fun newer(room: String, c: Cursor) = PageQuery(
        "room = {:room} && (created > {:created} || (created = {:created} && id > {:id}))",
        mapOf("room" to room, "created" to c.created, "id" to c.id),
        ASC,
    )

    /** Messages from [from] to [to] (inclusive, by created) changed after [since]: edits and deletes missed offline. */
    fun changedIn(room: String, since: String, from: Cursor, to: Cursor) = PageQuery(
        "room = {:room} && updated > {:since} && created >= {:from} && created <= {:to}",
        mapOf("room" to room, "since" to since, "from" to from.created, "to" to to.created),
        "updated,id",
    )

    /** Only the messages of [q] that may have attachments: their own, or a forward's original's (§17.7). */
    fun withFiles(q: PageQuery) = q.copy(filter = "${q.filter} && (files:length > 0 || forward_of != \"\")")
}
