package chat.android.data.lib

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// The app offers exactly the emoji the server accepts as reactions (§20.1): pb_hooks/lib/emoji.js, line by line.
class EmojiTest {
    @Test fun `matches the server's list, category by category`() {
        val js = File(System.getProperty("chat.repoRoot"), "pb_hooks/lib/emoji.js").readText()
        val lines = Regex("^  \"([^\"]+)\",$", RegexOption.MULTILINE).findAll(js).map { it.groupValues[1] }.toList()
        assertEquals(EMOJI_CATEGORIES.map { it.emoji.joinToString(" ") }, lines)
    }

    @Test fun `quick reactions are among them`() {
        for (e in QUICK_REACTIONS) assertTrue(e, e in EMOJI)
    }
}
