package chirkle.android.data.lib

import chirkle.android.data.model.Cursor
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

// The shared test vectors (shared/vectors/): the cases the web (tests/unit/vectors.test.ts) and the server's
// pb_hooks/lib/text.js pass too.
class VectorsTest {
    private val text = shared("vectors/text.json")
    private val jump = shared("vectors/jump.json")

    @Test fun foldKey() {
        for (c in text.cases("foldKey")) assertEquals(c.str("input"), c.str("output"), foldKey(c.str("input")))
    }

    @Test fun searchWords() {
        for (c in text.cases("searchWords")) assertEquals(c.str("input"), c.strings("output"), searchWords(c.str("input")))
    }

    @Test fun searchQuery() {
        for (c in text.cases("searchQuery")) {
            val before = c.getValue("before").takeIf { it != JsonNull }?.jsonObject?.let { Cursor(it.str("created"), it.str("id")) }
            val q = searchQuery(c.str("room"), c.strings("words"), before)
            val out = c.getValue("output").jsonObject
            assertEquals(out.str("filter"), q.filter)
            assertEquals(out.getValue("params").jsonObject.mapValues { it.value.jsonPrimitive.content }, q.params)
            assertEquals(out.str("sort"), q.sort)
        }
    }

    @Test fun highlight() {
        for (c in text.cases("highlight")) assertEquals(c.str("text"), c.strings("output"), highlight(c.str("text"), c.strings("words")))
    }

    @Test fun textLength() {
        for (c in text.cases("textLength")) assertEquals(c.str("input"), c.num("output"), textLength(c.str("input")))
    }

    @Test fun isBlank() {
        for (c in text.cases("isBlank")) assertEquals(c.str("input"), c.getValue("output").jsonPrimitive.boolean, isBlank(c.str("input")))
    }

    @Test fun jumpFold() {
        for (c in jump.cases("fold")) assertEquals(c.str("output"), jumpFold(c.str("input")))
    }

    @Test fun jumpScore() {
        for (c in jump.cases("score")) assertEquals("${c.str("name")} / ${c.str("query")}", c.num("output"), jumpScore(c.str("name"), jumpFold(c.str("query"))))
    }
}
