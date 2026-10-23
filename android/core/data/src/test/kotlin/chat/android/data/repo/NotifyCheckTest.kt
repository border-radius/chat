package chat.android.data.repo

import chat.android.data.api.NewMessage
import chat.android.data.lib.newId
import chat.android.data.testing.TestServer.newUser
import chat.android.data.testing.TestServer.uniq
import chat.android.data.testing.testDb
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The background check for notifications (ANDROID.md §8) against the real server: DMs and replies to you only.
@RunWith(RobolectricTestRunner::class)
class NotifyCheckTest {
    @Test fun `finds new DMs and replies to you, once, and not what is read, hidden or from before`() = runBlocking {
        val alice = newUser()
        val bob = newUser()
        val room = alice.api.createRoom("r-${uniq()}")
        val question = bob.api.send(NewMessage(newId(), room.id, "a question"))
        val dm = alice.api.openDm(bob.user.id)
        alice.api.send(NewMessage(newId(), dm.id, "before the session"))

        val check = NotifyCheck(bob.api, testDb())
        check.begin()
        alice.api.send(NewMessage(newId(), dm.id, "hi bob"))
        alice.api.send(NewMessage(newId(), room.id, "not for bob"))
        alice.api.send(NewMessage(newId(), room.id, "the answer", replyTo = question.id))

        val first = check.run()!!
        val byRoom = first.notices.associate { it.room.id to it.messages.map { m -> m.text } }
        // Nothing from before the session began is news.
        assertEquals(listOf("hi bob"), byRoom[dm.id])
        assertEquals(listOf("the answer"), byRoom[room.id])
        assertEquals(2, first.notices.single { it.room.id == dm.id }.unread)
        assertTrue(dm.id in first.unreadRooms && room.id in first.unreadRooms)

        // Seen: not again.
        assertTrue(check.run()!!.notices.isEmpty())

        // Read elsewhere: not notified, and no longer unread (its notification goes).
        val later = alice.api.send(NewMessage(newId(), dm.id, "read on the web"))
        bob.api.markRead(dm.id, later.created)
        val read = check.run()!!
        assertTrue(read.notices.isEmpty())
        assertFalse(dm.id in read.unreadRooms)

        // Hidden rooms stay silent.
        bob.api.hideRoom(room.id)
        alice.api.send(NewMessage(newId(), room.id, "again", replyTo = question.id))
        assertTrue(check.run()!!.notices.isEmpty())

        // On screen: counted as seen, not notified then or later.
        alice.api.send(NewMessage(newId(), dm.id, "while you look"))
        assertTrue(check.run(quiet = true)!!.notices.isEmpty())
        assertTrue(check.run()!!.notices.isEmpty())

        // The open room isn't notified.
        alice.api.send(NewMessage(newId(), dm.id, "in the open room"))
        assertTrue(check.run(openRoom = dm.id)!!.notices.isEmpty())
        assertTrue(check.run()!!.notices.isEmpty())
    }
}
