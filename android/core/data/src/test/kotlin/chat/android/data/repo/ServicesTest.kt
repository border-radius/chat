package chat.android.data.repo

import chat.android.data.api.NewMessage
import chat.android.data.lib.PageKind
import chat.android.data.lib.newId
import chat.android.data.model.SendStatus
import chat.android.data.model.Visibility
import chat.android.data.testing.TestServer
import chat.android.data.testing.TestServer.newUser
import chat.android.data.testing.TestServer.uniq
import chat.android.data.testing.eventually
import chat.android.data.testing.closeServices
import chat.android.data.testing.services
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The services and the room controller as the screens use them, against the real server (ANDROID.md §13).
@RunWith(RobolectricTestRunner::class)
class ServicesTest {
    @After fun tearDown() = closeServices()

    @Test fun `the room list loads, follows realtime and is saved for the next launch`() = runBlocking {
        val u = newUser()
        val s = services(u)
        eventually(what = "rooms ready") { s.store.get().roomsStatus == LoadStatus.Ready }
        val room = u.api.createRoom("r-${uniq()}")
        eventually(what = "the new room") { room.id in s.store.get().rooms }
        eventually(what = "saved") { runBlocking { s.db.rooms().all().any { it.id == room.id } } }
        u.api.setArchived(room.id, true)
        eventually(what = "archived") { s.store.get().rooms[room.id]?.archived == true }
    }

    @Test fun `a guest sees Open Air rooms only, and can't post`() = runBlocking {
        val u = newUser()
        val open = u.api.createRoom("open-${uniq()}", Visibility.Open)
        val private = u.api.createRoom("priv-${uniq()}", Visibility.Private)
        u.api.send(NewMessage(newId(), open.id, "hello guests"))
        val g = services(null)
        eventually(what = "rooms") { g.store.get().roomsStatus == LoadStatus.Ready }
        assertTrue(open.id in g.store.get().rooms)
        assertFalse(private.id in g.store.get().rooms)
        val c = g.openRoom(open.id)
        eventually(what = "messages") { c.state.value.items.any { it.text == "hello guests" } }
        assertFalse(c.posting())
        assertFalse(c.send("hi"))
        c.close()
    }

    @Test fun `sends through the outbox, follows live messages, edits, reacts and deletes`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.state.value.phase == Phase.Ready }
        assertTrue(c.send("from the app"))
        eventually(what = "pending shown") { c.state.value.items.any { it.text == "from the app" } }
        eventually(what = "sent") { c.state.value.items.any { it.text == "from the app" && it.status == null } }
        assertEquals(listOf("from the app"), a.api.page(chat.android.data.lib.Pages.latest(room.id)).map { it.text })
        b.api.send(NewMessage(newId(), room.id, "from b"))
        eventually(what = "live") { c.state.value.items.any { it.text == "from b" } }
        val mine = c.state.value.items.first { it.text == "from the app" }
        assertTrue(c.edit(mine.id, "edited")!!.await())
        assertEquals("edited", c.find(mine.id)!!.text)
        val theirs = c.state.value.items.first { it.text == "from b" }
        assertTrue(c.react(theirs.id, "👍", true)!!.await())
        eventually(what = "reaction") { c.find(theirs.id)!!.reactions.singleOrNull()?.users == listOf(a.user.id) }
        assertNull("not mine to delete", c.remove(theirs.id)?.let { if (c.deletable(theirs)) it else null })
        assertTrue(c.remove(mine.id)!!.await())
        assertTrue(c.find(mine.id)!!.deleted)
        c.close()
        // Kept for next time: the room opens from it at once.
        eventually(what = "kept") { s.cache.peek(a.user.id, room.id)?.items?.size == 2 }
    }

    @Test fun `a reply is sent with its quote`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val q = a.api.send(NewMessage(newId(), room.id, "the question"))
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.find(q.id) != null }
        assertTrue(c.send("the answer", replyTo = c.find(q.id)))
        eventually(what = "sent with reply_to") { runBlocking { a.api.page(chat.android.data.lib.Pages.latest(room.id)).any { it.text == "the answer" && it.replyTo == q.id } } }
        eventually(what = "shown as sent") { c.state.value.items.any { it.text == "the answer" && it.status == null && it.expand?.replyTo?.text == "the question" } }
        c.close()
    }

    @Test fun `opens around a message far back, and jumps to the latest`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val sent = (1..130).map { a.api.send(NewMessage(newId(), room.id, "m$it")) }
        val s = services(a)
        val c = s.openRoom(room.id, msgId = sent[9].id)
        eventually(what = "around") { c.state.value.targetId == sent[9].id }
        assertTrue(c.state.value.hasNewer)
        assertTrue(c.state.value.items.any { it.id == sent[9].id })
        c.jump(PageKind.Latest)
        eventually(what = "latest") { c.state.value.items.lastOrNull()?.id == sent.last().id && !c.state.value.hasNewer }
        c.goTo(sent[1].id)
        eventually(what = "went back") { c.state.value.targetId == sent[1].id && c.state.value.items.any { it.id == sent[1].id } }
        c.close()
    }

    @Test fun `counts unread messages live, and reading the room clears them on the server`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val s = services(b)
        eventually(what = "counted") { s.store.get().counted && room.id in s.store.get().rooms }
        a.api.send(NewMessage(newId(), room.id, "one"))
        a.api.send(NewMessage(newId(), room.id, "two"))
        eventually(what = "two unread") { s.store.get().unread[room.id] == 2 }
        val c = s.openRoom(room.id)
        eventually(what = "opened at the first unread") { c.state.value.unreadId != null }
        val reader = s.unread.open(room.id)
        reader.seen(c.state.value.items.last().created)
        reader.close(caughtUp = true)
        eventually(what = "read on the server") { runBlocking { b.api.unreadCounts().rooms[room.id] == null } }
        c.close()
        s.closeRoom(room.id)
    }

    @Test fun `a refused send shows as failed and can be discarded`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.state.value.phase == Phase.Ready }
        assertTrue(c.send("x".repeat(2001))) // over the limit: the server refuses it
        eventually(what = "failed") { c.state.value.items.any { it.status == SendStatus.Failed } }
        c.discard(c.state.value.items.first { it.status == SendStatus.Failed }.id)
        eventually(what = "gone") { c.state.value.items.isEmpty() }
        c.close()
    }

    @Test fun `logging out clears the session's data`() = runBlocking {
        val a = newUser()
        val s = services(a)
        eventually(what = "rooms") { s.store.get().roomsStatus == LoadStatus.Ready }
        a.api.createRoom("r-${uniq()}")
        eventually(what = "saved") { runBlocking { s.db.rooms().all().isNotEmpty() } }
        s.logOut()
        eventually(what = "cleared") { s.store.get().user == null && runBlocking { s.db.rooms().all().none { it.json.contains("\"private\"") } } }
        assertNull(s.api.currentUser())
    }
}
