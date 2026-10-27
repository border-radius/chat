package chirkle.android.data.lib

import chirkle.android.data.lib.TextPart.Link
import chirkle.android.data.lib.TextPart.Plain
import org.junit.Assert.assertEquals
import org.junit.Test

// The cases of tests/unit/lib/links.test.ts: the app links exactly what the web app does (§7.6.3).
class LinksTest {
    private fun link(text: String, href: String = text) = Link(text, href)
    private fun p(text: String) = Plain(text)

    @Test fun `leaves text without links as it is`() {
        assertEquals(listOf(p("hello there")), linkify("hello there"))
        assertEquals(emptyList<TextPart>(), linkify(""))
    }

    @Test fun `finds http and https URLs with the text around them`() {
        assertEquals(listOf(p("see "), link("https://example.com/a?b=1#c"), p(" now")), linkify("see https://example.com/a?b=1#c now"))
        assertEquals(listOf(link("http://example.com", "http://example.com/")), linkify("http://example.com"))
        assertEquals(
            listOf(p("a "), link("https://a.io", "https://a.io/"), p(" b "), link("https://b.io", "https://b.io/")),
            linkify("a https://a.io b https://b.io"),
        )
    }

    @Test fun `links www addresses over https`() {
        assertEquals(listOf(p("go to "), link("www.example.com", "https://www.example.com/")), linkify("go to www.example.com"))
    }

    @Test fun `keeps sentence punctuation out of the link`() {
        assertEquals(listOf(p("look: "), link("https://example.com/x"), p(".")), linkify("look: https://example.com/x."))
        assertEquals(listOf(link("https://example.com/x"), p("?!")), linkify("https://example.com/x?!"))
        assertEquals(listOf(p("\""), link("https://example.com/x"), p("\",")), linkify("\"https://example.com/x\","))
    }

    @Test fun `keeps typographic quotes, an ellipsis and CJK punctuation out`() {
        assertEquals(listOf(p("„"), link("https://example.com/x"), p("“")), linkify("„https://example.com/x“"))
        assertEquals(
            listOf(p("‘"), link("https://example.com/x"), p("’ «"), link("https://example.com/y"), p("»")),
            linkify("‘https://example.com/x’ «https://example.com/y»"),
        )
        assertEquals(listOf(link("https://example.com", "https://example.com/"), p("…")), linkify("https://example.com…"))
        assertEquals(listOf(p("见"), link("https://example.com/x"), p("。")), linkify("见https://example.com/x。"))
    }

    @Test fun `doesn't link the www inside an email address or a longer host name`() {
        for (text in listOf("bob@www.example.com", "my.www.example.com", "x-www.example.com")) assertEquals(listOf(p(text)), linkify(text))
        assertEquals(listOf(p("end."), link("https://example.com/x")), linkify("end.https://example.com/x"))
    }

    @Test fun `keeps a closing bracket the link didn't open out of it`() {
        assertEquals(listOf(p("(see "), link("https://example.com/x"), p(")")), linkify("(see https://example.com/x)"))
        assertEquals(listOf(link("https://en.wikipedia.org/wiki/Rust_(language)")), linkify("https://en.wikipedia.org/wiki/Rust_(language)"))
        assertEquals(
            listOf(p("("), link("https://en.wikipedia.org/wiki/Rust_(language)"), p(").")),
            linkify("(https://en.wikipedia.org/wiki/Rust_(language))."),
        )
        assertEquals(listOf(p("["), link("https://example.com/x"), p("]")), linkify("[https://example.com/x]"))
    }

    @Test fun `never links anything but http(s)`() {
        for (text in listOf("javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "mailto:a@example.com", "ftp://example.com")) {
            assertEquals(listOf(p(text)), linkify(text))
        }
        assertEquals(listOf(p("http:// nothing")), linkify("http:// nothing"))
        assertEquals(listOf(p("xhttps://example.com")), linkify("xhttps://example.com"))
    }

    @Test fun `stops at characters URLs don't contain unescaped`() {
        assertEquals(listOf(p("<"), link("https://example.com/x"), p(">")), linkify("<https://example.com/x>"))
        assertEquals(listOf(link("https://example.com/"), p("\"onmouseover=\"x")), linkify("https://example.com/\"onmouseover=\"x"))
    }

    @Test fun `ends a link at the spaces JavaScript knows`() {
        assertEquals(listOf(link("https://example.com/x"), p(" next")), linkify("https://example.com/x next"))
        assertEquals(listOf(link("https://example.com/x"), p("　次")), linkify("https://example.com/x　次"))
    }
}
