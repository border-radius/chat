// Room helpers that depend on who is looking (DESIGN.md §16.5, §23): web/src/lib/rooms.ts and the selectors of store.ts.
package chat.android.data.lib

import chat.android.data.model.Posting
import chat.android.data.model.Room
import chat.android.data.model.User
import chat.android.data.model.Visibility
import java.text.Collator

/** Who can see the room (§23.1); rooms from before visibility existed are public. */
val Room.visibilityOrDefault: Visibility get() = visibility ?: Visibility.Public

val Room.postingOrDefault: Posting get() = posting ?: Posting.Everyone

/** Can [me] post in a room they see (§23.6)? Guests never can; the creator always can. */
fun Room.canPost(me: String?): Boolean {
    if (me.isNullOrEmpty()) return false
    return postingOrDefault != Posting.Selected || createdBy == me || me in writers
}

/** How each visibility is called and explained (§23.1). */
val Visibility.label: String
    get() = when (this) {
        Visibility.Private -> "Private"
        Visibility.Public -> "Public"
        Visibility.Open -> "Open Air"
    }

val Visibility.hint: String
    get() = when (this) {
        Visibility.Private -> "Only the people you add can read and post."
        Visibility.Public -> "Everyone with an account can read and post."
        Visibility.Open -> "Anyone can read it, even without an account. Everyone with an account can post."
    }

/** The other member of a DM, if known. */
fun Room.otherMember(me: String?): User? {
    if (!isDm) return null
    val otherId = members.find { it != me } ?: return null
    return expand?.members?.find { it.id == otherId } ?: User(otherId, "Unknown")
}

/** What to call a room: "#name", or the other member's name for a DM. */
fun Room.title(me: String?): String = if (isDm) otherMember(me)?.name ?: "Unknown" else "#$name"

data class RoomSections(val rooms: List<Room>, val dms: List<Room>, val hidden: List<Room>, val archived: List<Room>)

private val collator: Collator = Collator.getInstance().apply { strength = Collator.PRIMARY }
private val byName = Comparator<Room> { a, b -> collator.compare(a.name, b.name) }

/** Most recent activity first: the latest message, or creation for a DM without one yet. */
private val byActivity = Comparator<Room> { a, b ->
    val at = a.lastMessageAt.ifEmpty { a.created }
    val bt = b.lastMessageAt.ifEmpty { b.created }
    when {
        at < bt -> 1
        at > bt -> -1
        else -> a.id.compareTo(b.id)
    }
}

/**
 * Room list sections (§7.1, §16.5). Archived wins over hidden. Open DMs by activity; closed (hidden) DMs left out. A
 * DM nobody has written in yet is listed only for the member who opened it, and while it is open (QA BUG-29, BUG-37).
 */
fun roomSections(rooms: Collection<Room>, hidden: Set<String>, me: String?, activeRoomId: String?): RoomSections {
    val open = mutableListOf<Room>()
    val dms = mutableListOf<Room>()
    val hid = mutableListOf<Room>()
    val archived = mutableListOf<Room>()
    for (r in rooms) {
        when {
            r.isDm -> {
                val started = r.lastMessageAt.isNotEmpty() || r.createdBy == me || r.id == activeRoomId
                if (started && r.id !in hidden) dms += r
            }
            r.archived -> archived += r
            r.id in hidden -> hid += r
            else -> open += r
        }
    }
    return RoomSections(open.sortedWith(byName), dms.sortedWith(byActivity), hid.sortedWith(byName), archived.sortedWith(byName))
}

/** The badge for a room (§18.4): none for the room you are in, and none for hidden or archived rooms (§13). */
fun unreadBadge(room: Room, unread: Map<String, Int>, hidden: Set<String>, activeRoomId: String?): Int {
    if (room.id == activeRoomId || room.archived || room.id in hidden) return 0
    return unread[room.id] ?: 0
}
