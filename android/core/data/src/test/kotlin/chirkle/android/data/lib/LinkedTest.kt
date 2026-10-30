package chirkle.android.data.lib

import chirkle.android.data.model.Room
import chirkle.android.data.model.RoomExpand
import chirkle.android.data.model.Shared
import chirkle.android.data.model.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Linked instances (DESIGN.md §33.10): the cases of tests/component/views/room/linked.test.ts.
class LinkedTest {
    @Test fun `tells an address on another instance from a name`() {
        assertTrue(isAddress("ann@b.example"))
        assertTrue(isAddress("Ann Lee@chat.example.org"))
        assertTrue(isAddress("ann@127.0.0.1:8090"))
        assertFalse(isAddress("ann@b"))
        assertFalse(isAddress("ann"))
        assertFalse(isAddress("@b.example"))
    }

    @Test fun `says why a DM takes no messages, as the web's dmClosed (QA BUG-178)`() {
        val me = User("me", "Me")
        val dm = Room("d", kind = "dm", members = listOf("bob", "me"), expand = RoomExpand(listOf(me, User("bob", "Bob"))))
        assertEquals("", dm.dmClosed(me))
        assertEquals("", Room("r").dmClosed(me))
        assertEquals("", dm.dmClosed(null))
        val closed = dm.copy(expand = RoomExpand(listOf(me, User("bob", "Bob (B)", noDms = true))))
        assertEquals("Bob (B) doesn't take direct messages.", closed.dmClosed(me))
        assertEquals("You've turned off direct messages.", dm.dmClosed(me.copy(noDms = true)))
    }

    @Test fun `says where else a shared room is held, and when its home is down`() {
        assertEquals("", Room("r").sharedNote())
        assertEquals("", Room("r", shared = Shared()).sharedNote())
        assertEquals("Shared with b.example, c.example", Room("r", shared = Shared(with = listOf("b.example", "c.example"))).sharedNote())
        assertEquals(
            "Shared with a.example · a.example can't be reached right now",
            Room("r", shared = Shared(home = "a.example", with = listOf("a.example"), down = true)).sharedNote(),
        )
    }
}
