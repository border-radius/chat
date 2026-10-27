package chirkle.android.data.lib

import chirkle.android.data.model.Room
import chirkle.android.data.model.RoomExpand
import chirkle.android.data.model.User
import org.junit.Assert.assertEquals
import org.junit.Test

// Jump to (§32): the cases of tests/unit/views/switcher.test.ts "jump to: matching".
class JumpTest {
    @Test fun `folds case, accents and width`() {
        assertEquals("ete abc", jumpFold("Été ＡＢＣ"))
    }

    @Test fun `ranks the whole name, its start, a word's start, inside a word, then letters in order`() {
        assertEquals(0, jumpScore("general", "general"))
        assertEquals(1, jumpScore("general", "gen"))
        assertEquals(2, jumpScore("old-general", "gen"))
        assertEquals(2, jumpScore("dev-ops", "ops"))
        assertEquals(3, jumpScore("general", "ner"))
        assertEquals(4, jumpScore("general", "gnrl"))
        assertEquals(-1, jumpScore("general", "xyz"))
        assertEquals(4, jumpScore("🍕 pizza", "🍕z")) // QA BUG-138
    }

    private val me = User("me", "Me")
    private val bob = User("bob", "Bob Été")
    private val general = Room("gen", "general", created = "2026-10-01 10:00:00.000Z")
    private val random = Room("ran", "random", created = "2026-10-02 10:00:00.000Z")
    private val devOps = Room("dev", "dev-ops", created = "2026-09-01 10:00:00.000Z")
    private val old = Room("old", "old-general", archived = true, created = "2026-10-03 10:00:00.000Z")
    private val dm = Room("dm", kind = "dm", members = listOf("me", "bob"), lastMessageAt = "2026-10-01 12:00:00.000Z", expand = RoomExpand(members = listOf(me, bob)))
    private val sections = RoomSections(listOf(devOps, general, random), listOf(dm), emptyList(), listOf(old))

    @Test fun `with nothing typed, the most recent first and no archived room`() {
        assertEquals(listOf("random", "Bob Été", "general", "dev-ops"), jumpMatches(jumpTargets(sections, "me") { "" }, "").map { it.name })
    }

    @Test fun `a room open a moment ago comes first (QA BUG-134)`() {
        val opened = mapOf("dev" to "2026-10-23 09:00:00.000Z")
        assertEquals("dev-ops", jumpMatches(jumpTargets(sections, "me") { opened[it].orEmpty() }, "").first().name)
    }

    @Test fun `typed - best match first, archived ones found but after, # and @ ignored`() {
        val all = jumpTargets(sections, "me") { "" }
        assertEquals(listOf("general", "old-general"), jumpMatches(all, "#gen").map { it.name })
        assertEquals("Archived", jumpMatches(all, "old").single().note)
        assertEquals(listOf("Bob Été"), jumpMatches(all, "@bob ete").map { it.name })
        assertEquals(emptyList<String>(), jumpMatches(all, "zzz").map { it.name })
    }
}
