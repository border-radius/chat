package chirkle.android.data.repo

import chirkle.android.data.api.ChirkleApi
import chirkle.android.data.api.NewMessage
import chirkle.android.data.pb.MemoryAuthStore
import chirkle.android.data.pb.PbClient
import chirkle.android.data.testing.TestServer
import chirkle.android.data.lib.newId
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import chirkle.android.data.testing.testDb
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The background check for notifications (ANDROID.md §8) against the real server: DMs, replies to you and the rooms chosen (§24).
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

    @Test fun `every message of a room chosen notifies, other rooms' don't (§24)`() = runBlocking {
        val alice = newUser()
        val bob = newUser()
        val chosen = alice.api.createRoom("r-${uniq()}")
        val other = alice.api.createRoom("r-${uniq()}")
        val db = testDb()
        val rooms = NotifyRooms(db, this)
        rooms.set(chosen.id, true)
        kotlinx.coroutines.yield()
        assertEquals(setOf(chosen.id), NotifyRooms.read(db))

        val check = NotifyCheck(bob.api, db)
        check.begin()
        alice.api.send(NewMessage(newId(), chosen.id, "for everyone"))
        alice.api.send(NewMessage(newId(), other.id, "not chosen"))
        val notices = check.run()!!.notices
        assertEquals(listOf("for everyone"), notices.single().messages.map { it.text })
        assertEquals(chosen.id, notices.single().room.id)

        // Turned off again: silent.
        rooms.set(chosen.id, false)
        kotlinx.coroutines.yield()
        assertTrue(NotifyRooms.read(db).isEmpty())
        alice.api.send(NewMessage(newId(), chosen.id, "now quiet"))
        assertTrue(check.run()!!.notices.isEmpty())
    }

    @Test fun `a check that fails on the way loses nothing, the next one notifies (QA BUG-153)`() = runBlocking {
        val alice = newUser()
        val bob = newUser()
        val dm = alice.api.openDm(bob.user.id)
        var offline = false
        val http = TestServer.http.newBuilder().addInterceptor { chain ->
            val url = chain.request().url.toString()
            if (offline && ("room_reads" in url || "/rooms/records/" in url)) throw java.io.IOException("offline")
            chain.proceed(chain.request())
        }.build()
        val api = ChirkleApi(PbClient(TestServer.url, http, MemoryAuthStore(bob.api.pb.authStore.session.value)))
        val check = NotifyCheck(api, testDb())
        check.begin()
        alice.api.send(NewMessage(newId(), dm.id, "hi bob"))
        offline = true
        assertTrue(runCatching { check.run() }.isFailure)
        offline = false
        assertEquals(listOf("hi bob"), check.run()!!.notices.single().messages.map { it.text })
    }
}
