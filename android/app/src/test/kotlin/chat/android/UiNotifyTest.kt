package chat.android

import android.app.NotificationManager
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import chat.android.data.api.NewMessage
import chat.android.data.lib.newId
import chat.android.data.testing.TestServer.newUser
import chat.android.data.testing.TestServer.uniq
import chat.android.notify.CheckWorker
import chat.android.notify.Notifications
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// Notifications from the background check (ANDROID.md §8): a DM and a reply to you notify, other messages don't.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiNotifyTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    @Test fun `a DM and a reply to you notify, in the background`() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        Notifications.createChannels(app)
        val alice = newUser("alice-${uniq()}")
        val bob = newUser()
        val room = runBlocking { alice.api.createRoom("r-${uniq()}") }
        val question = runBlocking { bob.api.send(NewMessage(newId(), room.id, "a question")) }
        val dm = runBlocking { alice.api.openDm(bob.user.id) }
        ui.signedIn(bob)
        val accounts = ui.accounts!!
        fun check() {
            var done: CheckWorker.Outcome? = null
            accounts.scope.launch { done = CheckWorker.checkAll(app, accounts) }
            compose.waitUntil(15_000) { ui.pump(); done != null }
            assertEquals(CheckWorker.Outcome.Done, done)
        }
        // The first check begins: what came before isn't news.
        check()
        runBlocking {
            alice.api.send(NewMessage(newId(), dm.id, "hi bob"))
            alice.api.send(NewMessage(newId(), room.id, "not for bob"))
            alice.api.send(NewMessage(newId(), room.id, "the answer", replyTo = question.id))
        }
        check()
        val nm = app.getSystemService(NotificationManager::class.java)
        val shown = shadowOf(nm).allNotifications.associate { n ->
            n.channelId to NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)!!.messages.map { it.text.toString() }
        }
        assertEquals(mapOf(Notifications.DMS to listOf("hi bob"), Notifications.ROOMS to listOf("the answer")), shown)

        // Read on another device: the next check takes its notification away.
        runBlocking {
            val last = bob.api.page(chat.android.data.lib.PageQuery("room = {:r}", mapOf("r" to dm.id), "-created,-id"), 1).single()
            bob.api.markRead(dm.id, last.created)
        }
        check()
        assertEquals(listOf(Notifications.ROOMS), shadowOf(nm).allNotifications.map { it.channelId })
    }
}
