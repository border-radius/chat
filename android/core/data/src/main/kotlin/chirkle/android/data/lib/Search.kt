// Message search (DESIGN.md §29): web/src/views/room/search.ts. Matched on text_key, the text folded on the server.
package chirkle.android.data.lib

import chirkle.android.data.model.Cursor

/** At most this many words count; the rest are ignored. */
private const val MAX_WORDS = 5
/** Text shown before the first match in a result, at most (characters). */
private const val LEAD = 40

/** The words of a search, folded, each once. */
fun searchWords(q: String): List<String> =
    foldKey(q).split(Regex("[\\s\\u00A0\\u2000-\\u200A\\u3000]+")).filter { it.isNotEmpty() }.distinct().take(MAX_WORDS)

/**
 * The newest messages of [room] with every word, before [before] when given (newest first). `~` treats `%` as a
 * wildcard, so it is escaped (QA BUG-34), and so is the escape character itself (QA BUG-112).
 */
fun searchQuery(room: String, words: List<String>, before: Cursor? = null): PageQuery {
    val params = linkedMapOf("room" to room)
    val parts = mutableListOf("room = {:room}")
    words.forEachIndexed { i, w ->
        params["w$i"] = w.replace(Regex("[\\\\%]")) { "\\" + it.value }
        parts += "text_key ~ {:w$i}"
    }
    if (before != null) {
        params["created"] = before.created
        params["id"] = before.id
        parts += "(created < {:created} || (created = {:created} && id < {:id}))"
    }
    return PageQuery(parts.joinToString(" && "), params, "-created,-id")
}

/**
 * [text] as runs of plain and matched (odd indexes) text, starting shortly before the first match. Matched ignoring
 * case as typed: a match only folding finds ("strasse" in "Straße") just isn't marked.
 */
fun highlight(text: String, words: List<String>): List<String> {
    val one = text.replace(Regex("\\s+"), " ").trim()
    if (words.isEmpty()) return listOf(one)
    val re = Regex(words.joinToString("|") { Regex.escape(it) }, setOf(RegexOption.IGNORE_CASE))
    val first = re.find(one)?.range?.first ?: -1
    val from = if (first > LEAD) {
        val space = one.lastIndexOf(' ', first - LEAD / 2)
        if (space >= 0) space + 1 else first - LEAD / 2
    } else 0
    val shown = (if (from > 0) "…" else "") + one.substring(from)
    val out = mutableListOf<String>()
    var at = 0
    for (m in re.findAll(shown)) {
        out += shown.substring(at, m.range.first)
        out += m.value
        at = m.range.last + 1
    }
    out += shown.substring(at)
    return out
}
