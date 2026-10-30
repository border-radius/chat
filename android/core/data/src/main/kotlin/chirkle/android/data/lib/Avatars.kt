// Avatar fallback (DESIGN.md §15.4): initials and a colour picked from the user id, as web/src/lib/avatar.ts.
package chirkle.android.data.lib

import java.text.BreakIterator
import java.util.Locale

const val AVATAR_COLORS = 8

private val BRACKETED = Regex("^\\(.*\\)$")
private val LEADING_PUNCTUATION = Regex("^\\p{P}+")

private fun firstGrapheme(word: String): String {
    val it = BreakIterator.getCharacterInstance()
    it.setText(word)
    val end = it.next()
    return if (end == BreakIterator.DONE) "" else word.substring(0, end)
}

/**
 * Up to two initials: the first letters of the first two words, upper-cased. "?" for a blank name. A word in brackets
 * (the label of a linked instance or Telegram, "Ann (B)", §33.4) and punctuation before a word ("“Bob”") don't count.
 */
fun initials(name: String): String {
    val words = name.trim().split(Regex("\\s+"))
        .filterNot { BRACKETED.matches(it) }
        .map { it.replace(LEADING_PUNCTUATION, "") }
        .filter { it.isNotEmpty() }
        .take(2)
    return words.joinToString("") { firstGrapheme(it).uppercase(Locale.getDefault()) }.ifEmpty { "?" }
}

/** Palette index for a user id (FNV-1a over UTF-16 units), stable across renames. */
fun avatarColor(id: String): Int {
    var h = 0x811c9dc5.toInt()
    for (c in id) {
        h = h xor c.code
        h *= 0x01000193
    }
    return ((h.toLong() and 0xffffffffL) % AVATAR_COLORS).toInt()
}
