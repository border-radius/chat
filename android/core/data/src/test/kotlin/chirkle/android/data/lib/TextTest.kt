package chirkle.android.data.lib

import chirkle.android.data.model.Cursor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Folding and search: the cases of tests/component/views/room/search.test.ts (§29), and the lengths of limits.ts.
class TextTest {
    @Test fun `folds like the server's nameKey`() {
        assertEquals("strasse abc über", foldKey("Straße ＡＢＣ Ü​ber"))
        assertEquals("привет", foldKey("ПРИВЕТ"))
        assertEquals("istanbul izmir", foldKey("İSTANBUL İzmir")) // QA BUG-113
    }

    @Test fun `splits a search into folded words, each once, at most five`() {
        assertEquals(listOf("hello", "world"), searchWords("  Hello   hello WORLD "))
        assertEquals(listOf("a", "b", "c", "d", "e"), searchWords("a b c d e f g"))
        assertEquals(emptyList<String>(), searchWords(" ​ "))
    }

    @Test fun `builds a newest-first filter with every word bound and escaped`() {
        val q = searchQuery("r1", listOf("100%", "x"))
        assertEquals("room = {:room} && text_key ~ {:w0} && text_key ~ {:w1}", q.filter)
        assertEquals(mapOf("room" to "r1", "w0" to "100\\%", "w1" to "x"), q.params)
        assertEquals("-created,-id", q.sort)
        assertEquals("a\\\\\\%b", searchQuery("r1", listOf("a\\%b")).params["w0"]) // QA BUG-112
        val c = searchQuery("r1", listOf("x"), Cursor("2026-10-18 10:00:00.000Z", "abc"))
        assertEquals("room = {:room} && text_key ~ {:w0} && (created < {:created} || (created = {:created} && id < {:id}))", c.filter)
        assertEquals("abc", c.params["id"])
    }

    @Test fun `marks the matches, starting shortly before the first`() {
        assertEquals(listOf("Say ", "HELLO", " to ", "hello", "."), highlight("Say HELLO to hello.", listOf("hello")))
        assertEquals(listOf("one ", "two", ""), highlight("one\n\ntwo", listOf("two")))
        val parts = highlight("word ".repeat(30) + "needle end", listOf("needle"))
        assertTrue(parts[0].startsWith("…"))
        assertTrue(parts[0].length < 40)
        assertEquals("needle", parts[1])
        assertEquals(listOf("", "a.b", " axb"), highlight("a.b axb", listOf("a.b")))
    }

    @Test fun `counts code points as PocketBase does`() {
        assertEquals(1, textLength("😀"))
        assertEquals(5, textLength("héllo"))
        assertTrue(isBlank(" ​⁠ "))
    }
}
