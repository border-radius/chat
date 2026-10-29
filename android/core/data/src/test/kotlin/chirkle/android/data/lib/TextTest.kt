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

    @Test fun `asks for the newest page with the words, then the page older than the last result`() {
        assertEquals(PageQuery("r1", "latest", q = "100% x"), searchQuery("r1", listOf("100%", "x")))
        val c = Cursor("2026-10-18 10:00:00.000Z", "abc")
        assertEquals(PageQuery("r1", "older", mapOf("created" to c.created, "id" to "abc"), q = "x"), searchQuery("r1", listOf("x"), c))
        // On a server from before the route, the old filter (QA BUG-34, BUG-112).
        val old = searchQuery("r1", listOf("100%", "x")).legacy()
        assertEquals("room = {:room} && text_key ~ {:w0} && text_key ~ {:w1}", old.filter)
        assertEquals(mapOf("room" to "r1", "w0" to "100\\%", "w1" to "x"), old.params)
        assertEquals("a\\\\\\%b", searchQuery("r1", listOf("a\\%b")).legacy().params["w0"])
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
