// Finding a room or DM by name (DESIGN.md §32, "Jump to"): a port of matches and score in web/src/views/switcher.ts.
// On the phone it is the room list's search; Ctrl+K opens it from a hardware keyboard.
package chat.android.data.lib

import chat.android.data.model.Room
import java.text.Normalizer

/** A room or DM to go to. [note]: "Hidden" or "Archived" (found only when typed for), else "". */
data class JumpTarget(val room: Room, val name: String, val note: String, val at: String) {
    val away: Boolean get() = note.isNotEmpty()
}

private const val MAX_TARGETS = 50
private val MARKS = Regex("\\p{M}+")

/** Case, accents and width folded: "élan" and "ＥＬＡＮ" are found by "elan". */
fun jumpFold(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKD).replace(MARKS, "").lowercase()

private fun isWordChar(cp: Int) = Character.isLetter(cp) || Character.isDigit(cp)

/**
 * How well [name] matches the folded query [q], best first: 0 the whole name, 1 its start, 2 a word's start, 3 inside
 * a word, 4 its letters in order; -1 not at all.
 */
fun jumpScore(name: String, q: String): Int {
    val n = jumpFold(name)
    if (n == q) return 0
    var i = n.indexOf(q)
    while (i >= 0) {
        if (i == 0) return 1
        if (!isWordChar(n.codePointBefore(i))) return 2
        i = n.indexOf(q, i + 1)
    }
    if (n.contains(q)) return 3
    // By code point: an emoji is one letter (QA BUG-138).
    val letters = q.filterNot { it.isWhitespace() }.codePoints().toArray()
    var j = 0
    for (c in n.codePoints()) if (j < letters.size && c == letters[j]) j++
    return if (j == letters.size) 4 else -1
}

/**
 * When each room was last open in this process (entered or left), as PocketBase dates: rooms have no latest message
 * time (only DMs do), so this is what puts a room you just used first (QA BUG-134). One per account (ChatServices),
 * forgotten when its session changes (QA BUG-136, BUG-152) and when the app restarts.
 */
class RecentlyOpened {
    private val at = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun note(roomId: String) {
        at[roomId] = java.time.Instant.now().toString().replace('T', ' ')
    }

    operator fun get(roomId: String): String = at[roomId].orEmpty()

    fun clear() = at.clear()
}

/** Everything you can jump to, from the room list's sections. [opened]: when a room was last open, "" if not yet. */
fun jumpTargets(s: RoomSections, me: String?, opened: (String) -> String): List<JumpTarget> {
    fun t(r: Room, note: String): JumpTarget {
        val sent = r.lastMessageAt.ifEmpty { r.created }
        val open = opened(r.id)
        return JumpTarget(r, if (r.isDm) r.otherMember(me)?.name ?: "Unknown" else r.name, note, if (open > sent) open else sent)
    }
    return s.rooms.map { t(it, "") } + s.dms.map { t(it, "") } + s.hidden.map { t(it, "Hidden") } + s.archived.map { t(it, "Archived") }
}

/**
 * What to show for [query]: the best matches first, then those not hidden or archived, then the most recent. With
 * nothing typed, everything but hidden and archived rooms, most recent first. A leading "#" or "@" is ignored.
 */
fun jumpMatches(all: List<JumpTarget>, query: String): List<JumpTarget> {
    val q = jumpFold(query.trim().removePrefix("#").removePrefix("@").trim())
    val recent = compareByDescending<JumpTarget> { it.at }
    if (q.isEmpty()) return all.filter { !it.away }.sortedWith(recent).take(MAX_TARGETS)
    return all.map { it to jumpScore(it.name, q) }
        .filter { it.second >= 0 }
        .sortedWith(compareBy<Pair<JumpTarget, Int>> { it.second }.thenBy { it.first.away }.thenByDescending { it.first.at })
        .take(MAX_TARGETS)
        .map { it.first }
}
