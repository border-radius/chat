// Avatar fallback (DESIGN.md §15.4): initials and a colour picked from the user id, as web/src/lib/avatar.ts.
package chirkle.android.data.lib

import java.text.BreakIterator
import java.util.Locale

const val AVATAR_COLORS = 8

private fun firstGrapheme(word: String): String {
    val it = BreakIterator.getCharacterInstance()
    it.setText(word)
    val end = it.next()
    return if (end == BreakIterator.DONE) "" else word.substring(0, end)
}

/** Up to two initials: the first letters of the first two words, upper-cased. "?" for a blank name. */
fun initials(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2)
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
