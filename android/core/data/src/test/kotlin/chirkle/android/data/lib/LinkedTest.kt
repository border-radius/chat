package chirkle.android.data.lib

import chirkle.android.data.model.Room
import chirkle.android.data.model.Shared
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Linked instances (DESIGN.md §33.10): the cases of tests/unit/views/room/linked.test.ts.
class LinkedTest {
    @Test fun `tells an address on another instance from a name`() {
        assertTrue(isAddress("ann@b.example"))
        assertTrue(isAddress("Ann Lee@chat.example.org"))
        assertTrue(isAddress("ann@127.0.0.1:8090"))
        assertFalse(isAddress("ann@b"))
        assertFalse(isAddress("ann"))
        assertFalse(isAddress("@b.example"))
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
