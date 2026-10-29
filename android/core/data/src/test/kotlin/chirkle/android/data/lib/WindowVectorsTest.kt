package chirkle.android.data.lib

import chirkle.android.data.model.Cursor
import chirkle.android.data.model.Message
import chirkle.android.data.model.SendStatus
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

// The message window's shared vectors (shared/vectors/window.json): Window.kt and Cursors.kt, against the cases the
// web's lib/messages.ts and lib/cursor.ts pass (tests/unit/lib/window-vectors.test.ts). Messages are read as
// tests/support/vectors.ts reads them.
class WindowVectorsTest {
    private val v = shared("vectors/window.json")

    private fun genId(i: Int) = "m" + i.toString().padStart(4, '0')

    private fun genCreated(i: Int): String {
        val s = 10 * 3600 + i
        fun two(n: Int) = n.toString().padStart(2, '0')
        return "2026-10-01 ${two(s / 3600)}:${two(s / 60 % 60)}:${two(s % 60)}.000Z"
    }

    private fun JsonObject.opt(name: String) = this[name]?.takeIf { it != JsonNull }?.jsonPrimitive?.content

    private fun message(o: JsonObject): Message {
        val created = o.opt("created").orEmpty()
        return Message(
            id = o.str("id"),
            room = "r",
            author = o.opt("author") ?: "a",
            text = o.opt("text").orEmpty(),
            created = created,
            updated = o.opt("updated") ?: created,
            deleted = o["deleted"]?.jsonPrimitive?.boolean ?: false,
            files = (o["files"] as? JsonArray)?.map { it.jsonPrimitive.content }
                ?: List(o["files"]?.jsonPrimitive?.int ?: 0) { "f$it" },
            forwardedFrom = o.opt("forwarded_from").orEmpty(),
            status = when (o.opt("status")) {
                "pending" -> SendStatus.Pending
                "failed" -> SendStatus.Failed
                else -> null
            },
        )
    }

    private fun messages(list: JsonArray): List<Message> = list.flatMap { el ->
        val o = el.jsonObject
        val gen = o["gen"]?.jsonArray ?: return@flatMap listOf(message(o))
        val from = gen[0].jsonPrimitive.int
        val to = gen[1].jsonPrimitive.int
        (if (from <= to) from..to else from downTo to).map { Message(genId(it), "r", author = "a", created = genCreated(it), updated = genCreated(it)) }
    }

    /** The window as the vectors describe it, in the shape of `expect`. */
    private fun shown(win: MessageWindow, dropped: List<String>?, e: JsonObject): Map<String, Any?> {
        val ids = win.items.map { it.id }
        val out = mutableMapOf<String, Any?>()
        if ("ids" in e) out["ids"] = ids else out += mapOf("count" to ids.size, "first" to ids.firstOrNull(), "last" to ids.lastOrNull())
        out["hasOlder"] = win.hasOlder
        out["hasNewer"] = win.hasNewer
        e["dropped"]?.let { d ->
            out["dropped"] = if (d is JsonArray) dropped else mapOf("count" to dropped!!.size, "first" to dropped.first(), "last" to dropped.last())
        }
        e["copies"]?.let { c ->
            out["copies"] = c.jsonArray.map { it.jsonObject.str("id") }.map { id ->
                val m = win.items.first { it.id == id }
                mapOf("id" to id, "updated" to m.updated, "text" to m.text, "status" to m.status?.name?.lowercase())
            }
        }
        return out
    }

    /** `expect` as plain values, to compare with [shown]. */
    private fun plain(e: JsonObject): Map<String, Any?> = e.mapValues { (k, x) ->
        when {
            k == "ids" || (k == "dropped" && x is JsonArray) -> x.jsonArray.map { it.jsonPrimitive.content }
            k == "count" -> x.jsonPrimitive.int
            k == "hasOlder" || k == "hasNewer" -> x.jsonPrimitive.boolean
            k == "dropped" -> x.jsonObject.let { mapOf("count" to it.num("count"), "first" to it.str("first"), "last" to it.str("last")) }
            k == "copies" -> x.jsonArray.map { c ->
                c.jsonObject.let { mapOf("id" to it.str("id"), "updated" to it.str("updated"), "text" to it.str("text"), "status" to it.opt("status")) }
            }
            else -> x.jsonPrimitive.content
        }
    }

    @Test fun `the app's page size and window are the web's`() {
        assertEquals(v.num("pageSize"), PAGE_SIZE)
        assertEquals(v.num("windowMax"), WINDOW_MAX)
    }

    @Test fun window() {
        for (c in v.cases("window")) {
            val start = c["start"]?.takeIf { it != JsonNull }?.jsonObject
            var win = if (start == null) MessageWindow() else {
                MessageWindow(hasOlder = start.getValue("hasOlder").jsonPrimitive.boolean, hasNewer = start.getValue("hasNewer").jsonPrimitive.boolean)
                    .merge(messages(start.getValue("messages").jsonArray))
            }
            c.cases("steps").forEachIndexed { i, s ->
                var dropped: List<String>? = null
                when (s.str("op")) {
                    "page" -> {
                        val kind = PageKind.entries.first { it.name.lowercase() == s.str("kind") }
                        val t = win.applyPage(messages(s.getValue("messages").jsonArray), kind)
                        win = t.win
                        dropped = t.dropped
                    }
                    "merge" -> win = win.merge(messages(s.getValue("messages").jsonArray))
                    "remove" -> win = win.remove(s.str("id"))
                    "trim" -> {
                        val t = win.trim(if (s.str("side") == "top") Side.Top else Side.Bottom, s.num("max"))
                        win = t.win
                        dropped = t.dropped
                    }
                }
                val e = s.getValue("expect").jsonObject
                assertEquals("${c.str("name")}, step ${i + 1}", plain(e), shown(win, dropped, e))
            }
        }
    }

    private fun windowOf(items: JsonArray) = MessageWindow(items = items.map { message(it.jsonObject) })

    @Test fun startsGroup() {
        for (g in v.cases("startsGroup")) {
            val prev = g["prev"]?.takeIf { it != JsonNull }?.jsonObject?.let(::message)
            assertEquals(g.toString(), g.getValue("output").jsonPrimitive.boolean, startsGroup(prev, message(g.getValue("cur").jsonObject)))
        }
    }

    @Test fun `lastSaved and lastOwnEditable`() {
        for (c in v.cases("lastSaved")) assertEquals(c.toString(), c.opt("output"), windowOf(c.getValue("items").jsonArray).lastSaved()?.id)
        for (c in v.cases("lastOwnEditable")) {
            assertEquals(c.toString(), c.opt("output"), windowOf(c.getValue("items").jsonArray).lastOwnEditable(c.str("me"))?.id)
        }
    }

    @Test fun `quoteText and emptyForward`() {
        for (q in v.cases("quoteText")) {
            assertEquals(q.toString(), q.str("output"), quoteText(q.str("text"), q.getValue("deleted").jsonPrimitive.boolean, q.num("files")))
        }
        for (f in v.cases("emptyForward")) {
            val m = message(JsonObject(f + ("id" to kotlinx.serialization.json.JsonPrimitive("f"))))
            assertEquals(f.toString(), f.getValue("output").jsonPrimitive.boolean, m.isEmptyForward())
        }
    }

    @Test fun `page queries`() {
        fun cursor(o: JsonObject, name: String) = o.getValue(name).jsonObject.let { Cursor(it.str("created"), it.str("id")) }
        fun of(fn: String, c: JsonObject): PageQuery = when (fn) {
            "latest" -> Pages.latest(c.str("room"))
            "first" -> Pages.first(c.str("room"))
            "older" -> Pages.older(c.str("room"), cursor(c, "cursor"))
            "newer" -> Pages.newer(c.str("room"), cursor(c, "cursor"))
            "changedIn" -> Pages.changedIn(c.str("room"), c.str("since"), cursor(c, "from"), cursor(c, "to"))
            else -> error(fn)
        }
        for (c in v.cases("cursors")) {
            val q = if (c.str("fn") == "withFiles") Pages.withFiles(of(c.str("of"), c)) else of(c.str("fn"), c)
            val out = c.getValue("output").jsonObject
            assertEquals(c.str("fn"), out.str("room"), q.room)
            assertEquals(c.str("fn"), out.str("kind"), q.kind)
            assertEquals(c.str("fn"), out.getValue("args").jsonObject.mapValues { it.value.jsonPrimitive.content }, q.args)
            assertEquals(c.str("fn"), out["files"]?.jsonPrimitive?.boolean ?: false, q.files)
        }
    }
}
