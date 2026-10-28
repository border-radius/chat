package chirkle.android.data.repo

import chirkle.android.data.api.ApiError
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.newId
import chirkle.android.data.model.SaveFrom
import chirkle.android.data.pb.UploadFile
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import chirkle.android.data.testing.closeServices
import chirkle.android.data.testing.eventually
import chirkle.android.data.testing.services
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// Media collections (DESIGN.md §31) as the app uses them: the calls, the store's list, and attaching through the outbox.
@RunWith(RobolectricTestRunner::class)
class CollectionsTest {
    @After fun tearDown() = closeServices()

    /** A 1×1 PNG. */
    private val png = byteArrayOf(
        -119, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, -60, -119, 0, 0, 0, 13, 73,
        68, 65, 84, 120, -38, 99, -8, -1, -1, 63, 0, 5, -2, 2, -2, -89, 53, -127, -124, 0, 0, 0, 0, 73, 69, 78, 68, -82, 66, 96, -126,
    )

    private fun dot(name: String = "dot.png") = UploadFile(name, "image/png", png.toRequestBody("image/png".toMediaType()))

    @Test fun `saving a message's file, which collections have it, and taking it out`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("cs-${uniq()}")
        val m = a.api.send(NewMessage(newId(), room.id, "pic", listOf(dot())))
        val coll = a.api.createCollection("Saved ${uniq()}", false)
        val from = SaveFrom.File(m.id, m.files.single())
        val item = a.api.saveItem(coll, from)
        assertEquals("dot.png", item.name)
        assertEquals(mapOf(coll to item.id), a.api.savedIn(from))
        // Twice: it is in there already.
        assertEquals(409, runCatching { a.api.saveItem(coll, from) }.exceptionOrNull().let { (it as ApiError).status })
        val (page, more) = a.api.collectionItems(coll)
        assertEquals(listOf(item.id), page.map { it.id })
        assertFalse(more)
        assertEquals(1, a.api.collections().mine.single { it.id == coll }.items)
        a.api.removeItem(item.id)
        assertEquals(emptyMap<String, String>(), a.api.savedIn(from))
    }

    @Test fun `pages of items go back in time, and newer ones come after the newest shown`() = runBlocking {
        val a = newUser()
        val coll = a.api.createCollection("Pages ${uniq()}", false)
        val up = (1..3).map { a.api.uploadItem(coll, dot("u$it.png")) }
        val (first, more) = a.api.collectionItems(coll, size = 2)
        assertEquals(listOf(up[2].id, up[1].id), first.map { it.id })
        assertTrue(more)
        assertEquals(listOf(up[0].id), a.api.collectionItems(coll, first.last(), size = 2).first.map { it.id })
        val later = a.api.uploadItem(coll, dot("u4.png"))
        assertEquals(listOf(later.id), a.api.collectionItems(coll, up[2], newer = true).first.map { it.id })
        assertEquals((up + later).map { it.id }.toSet(), a.api.itemIdsSince(coll, up[0]))
    }

    @Test fun `the store lists yours and those you follow, with new items until seen`() = runBlocking {
        val owner = newUser()
        val b = newUser()
        val coll = owner.api.createCollection("Shared ${uniq()}", true)
        val s = services(b)
        eventually(what = "the list") { s.store.get().collections != null }
        b.api.follow(coll, true)
        eventually(what = "followed") { s.store.get().collections?.subs?.any { it.id == coll } == true }
        assertEquals(owner.user.name, s.store.get().collections!!.subs.single { it.id == coll }.owner?.name)
        owner.api.uploadItem(coll, dot())
        eventually(what = "1 new, live") { s.store.get().collections?.subs?.single { it.id == coll }?.new == 1 }
        s.collections.seen(coll)
        assertEquals(0, s.store.get().collections!!.subs.single { it.id == coll }.new)
        eventually(what = "seen on the server") { runBlocking { b.api.collections() }.subs.single { it.id == coll }.new == 0 }
        // Made private: it leaves the list, live.
        owner.api.updateCollection(coll, public = false)
        eventually(what = "gone private") { s.store.get().collections?.subs?.none { it.id == coll } == true }
    }

    @Test fun `a follow made while the list's subscription is on its way still shows`() = runBlocking {
        val owner = newUser()
        val b = newUser()
        val coll = owner.api.createCollection("Shared ${uniq()}", true)
        // The subscriptions reach the server late: a follow from another device lands in between.
        val http = chirkle.android.data.testing.TestServer.http.newBuilder().addInterceptor { chain ->
            if (chain.request().method == "POST" && chain.request().url.encodedPath == "/api/realtime") Thread.sleep(1500)
            chain.proceed(chain.request())
        }.build()
        val main = java.util.concurrent.Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val s = ChirkleServices(chirkle.android.data.testing.TestServer.url, http, chirkle.android.data.pb.MemoryAuthStore(b.api.pb.authStore.session.value), chirkle.android.data.testing.testDb(), main)
        try {
            s.start()
            eventually(what = "the list") { s.store.get().collections != null }
            b.api.follow(coll, true)
            eventually(what = "followed") { s.store.get().collections?.subs?.any { it.id == coll } == true }
        } finally {
            s.close()
        }
    }

    @Test fun `a message attaches collection items through the outbox, and its badge names the collection`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("ca-${uniq()}")
        val name = "Mine ${uniq()}"
        val coll = a.api.createCollection(name, false)
        val item = a.api.uploadItem(coll, dot("from-coll.png"))
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.state.value.phase == Phase.Ready && room.id in s.store.get().rooms }
        assertTrue(c.send("with an item", items = listOf(item)))
        eventually(what = "sent") { c.state.value.items.any { it.text == "with an item" && it.status == null } }
        val m = c.state.value.items.single { it.text == "with an item" }
        assertEquals(listOf("from-coll.png"), m.files.map { m.fileNames[it] })
        assertEquals(mapOf(m.files.single() to coll), m.fileSources)
        // The copy's shape, as the server read it (§17.5): the tile has its size before the image loads.
        assertEquals(mapOf(m.files.single() to listOf(1, 1)), m.fileDims)
        c.close()
        // The owner sees its name; someone else that it is private; a collection that is gone, nothing.
        assertEquals(name, a.api.badges(listOf(coll))[coll]?.name)
        assertTrue(b.api.badges(listOf(coll))[coll]!!.private)
        a.api.deleteCollection(coll)
        assertNull(a.api.badges(listOf(coll))[coll])
    }

    @Test fun `badges follow a collection made public, renamed, made private and deleted, live`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val coll = a.api.createCollection("Secret ${uniq()}", false)
        val scope = CoroutineScope(coroutineContext + Job())
        val badges = Badges(b.api, scope)
        try {
            badges.want(listOf(coll))
            eventually(what = "private") { badges.state.value[coll]?.private == true }
            a.api.updateCollection(coll, public = true)
            eventually(what = "public") { badges.state.value[coll]?.public == true }
            val name = "Open ${uniq()}"
            a.api.updateCollection(coll, name = name)
            eventually(what = "renamed") { badges.state.value[coll]?.name == name }
            a.api.updateCollection(coll, public = false)
            eventually(what = "private again") { badges.state.value[coll]?.private == true }
            a.api.deleteCollection(coll)
            eventually(what = "gone") { coll in badges.state.value && badges.state.value[coll] == null }
        } finally {
            scope.cancel()
        }
    }
}
