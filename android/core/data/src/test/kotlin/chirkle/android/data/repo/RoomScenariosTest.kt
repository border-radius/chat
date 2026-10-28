package chirkle.android.data.repo

import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.PageKind
import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.Side
import chirkle.android.data.lib.cases
import chirkle.android.data.lib.newId
import chirkle.android.data.lib.num
import chirkle.android.data.lib.shared
import chirkle.android.data.lib.str
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import chirkle.android.data.testing.closeServices
import chirkle.android.data.testing.eventually
import chirkle.android.data.testing.services
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The room controller's shared scenarios (shared/vectors/room.json), recorded from the web's controller.ts
// (tests/component/views/room/scenarios.test.ts): RoomController against the real server must come to the same states.
@RunWith(RobolectricTestRunner::class)
class RoomScenariosTest {
    @After fun tearDown() = closeServices()

    private val scenarios = shared("vectors/room.json").cases("scenarios")

    private fun JsonObject.opt(name: String) = this[name]?.takeIf { it != JsonNull }?.jsonPrimitive?.content

    /** `expect` as plain values, to compare with what the controller shows. */
    private fun plain(e: JsonObject): Map<String, Any?> = mapOf(
        "first" to e.opt("first"),
        "last" to e.opt("last"),
        "count" to e.getValue("count").jsonPrimitive.int,
        "hasOlder" to e.getValue("hasOlder").jsonPrimitive.boolean,
        "hasNewer" to e.getValue("hasNewer").jsonPrimitive.boolean,
        "phase" to e.str("phase"),
        "target" to e.opt("target"),
        "unread" to e.opt("unread"),
        "pill" to e.opt("pill"),
        "deleted" to e.getValue("deleted").jsonArray.map { it.jsonPrimitive.content },
    )

    private fun phaseName(p: Phase) = when (p) {
        Phase.Loading -> "loading"
        Phase.Ready -> "ready"
        Phase.Failed -> "failed"
        Phase.NotFound -> "not-found"
    }

    @Test fun scenarios() = runBlocking {
        for (sc in scenarios) run(sc)
    }

    private suspend fun run(sc: JsonObject) {
        val name = sc.str("name")
        val author = newUser("author-${uniq()}")
        val other = newUser("other-${uniq()}")
        val room = author.api.createRoom("room-${uniq()}")
        val label = mutableMapOf<String, String>() // id → label
        fun idOf(l: String) = label.entries.first { it.value == l }.key
        for (i in 1..sc.num("seed")) label[author.api.send(NewMessage(newId(), room.id, "m$i")).id] = "m$i"
        val reader = if (sc.opt("reader") == "other") other else author
        sc.opt("readUpTo")?.let { upTo ->
            val page = reader.api.page(Pages.first(room.id))
            reader.api.markRead(room.id, page.first { it.id == idOf(upTo) }.created)
        }
        val s = services(reader)
        eventually(what = "$name: counted") { s.store.get().counted && room.id in s.store.get().rooms }
        var c: RoomController? = null
        fun shown(): Map<String, Any?> {
            val st = c!!.state.value
            fun of(id: String?) = id?.let { label[it] ?: it }
            return mapOf(
                "first" to of(st.items.firstOrNull()?.id),
                "last" to of(st.items.lastOrNull()?.id),
                "count" to st.items.size,
                "hasOlder" to st.hasOlder,
                "hasNewer" to st.hasNewer,
                "phase" to phaseName(st.phase),
                "target" to of(st.targetId),
                "unread" to of(st.unreadId),
                "pill" to st.pill?.name?.lowercase(),
                "deleted" to st.items.filter { it.deleted }.map { of(it.id)!! },
            )
        }
        sc.cases("steps").forEachIndexed { i, step ->
            when (step.str("do")) {
                "open" -> c = s.openRoom(room.id, msgId = step.opt("at")?.let(::idOf))
                "loadEdge" -> c!!.loadEdge(if (step.str("side") == "top") Side.Top else Side.Bottom)
                "jump" -> c!!.jump(if (step.str("to") == "first") PageKind.First else PageKind.Latest)
                "goTo" -> c!!.goTo(idOf(step.str("at")))
                "atBottom" -> c!!.atBottom = step.getValue("value").jsonPrimitive.boolean
                "say" -> {
                    val who = if (step.opt("who") == "other") other else author
                    label[who.api.send(NewMessage(newId(), room.id, step.str("text"))).id] = step.str("text")
                }
                "delete" -> author.api.softDelete(idOf(step.str("at")))
            }
            val want = plain(step.getValue("expect").jsonObject)
            try {
                eventually(what = "") { shown() == want }
            } catch (e: AssertionError) {
                throw AssertionError("$name, step ${i + 1} (${step.str("do")}):\n expected $want\n but was  ${shown()}")
            }
        }
        c?.close()
        s.closeRoom(room.id)
        closeServices()
    }
}
