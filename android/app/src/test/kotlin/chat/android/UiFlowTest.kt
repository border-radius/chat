package chat.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import chat.android.data.db.ChatDatabase
import chat.android.data.testing.TestServer
import chat.android.data.pb.MemoryAuthStore
import chat.android.data.repo.ChatServices
import chat.android.nav.ChatNav
import chat.android.ui.ChatTheme
import chat.android.ui.LocalServices
import androidx.compose.runtime.CompositionLocalProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// The app's screens, on Robolectric, against a real PocketBase (ANDROID.md §13): what an emulator run would do, minus
// the device. Each test is one of tests/e2e's parity scenarios (android/PARITY.md).
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiFlowTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    private fun start(session: chat.android.data.pb.Session = chat.android.data.pb.Session.NONE) = ui.start(session)

    @After fun tearDown() = ui.stop()

    private fun waitFor(ms: Long = 15_000, what: () -> androidx.compose.ui.test.SemanticsMatcher) {
        compose.waitUntil(ms) { compose.onAllNodes(what(), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun `log in, open a room, send a message and see it sent`() {
        val u = TestServer.newUser()
        val room = runBlocking { u.api.createRoom("ui-${TestServer.uniq()}") }
        start()
        waitFor { hasText("Just looking? Read the Open Air rooms") }
        compose.onNode(hasSetTextAction() and hasText("Email")).performTextInput(u.email)
        compose.onNode(hasSetTextAction() and hasText("Password")).performTextInput(TestServer.PASSWORD)
        compose.onAllNodes(hasText("Log in"))[1].performClick()
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        waitFor { hasText("Beginning of #${room.name}") }
        compose.onNode(hasContentDescription("Message")).performTextInput("hello from the app")
        compose.onNodeWithContentDescription("Send").performClick()
        waitFor { hasText("hello from the app") }
        compose.waitUntil(15_000) { runBlocking { u.api.page(chat.android.data.lib.Pages.latest(room.id)).any { it.text == "hello from the app" } } }
        compose.onNodeWithText("hello from the app").assertIsDisplayed()
    }

    @Test fun `a wrong password says so`() {
        val u = TestServer.newUser()
        start()
        waitFor { hasText("Just looking? Read the Open Air rooms") }
        compose.onNode(hasSetTextAction() and hasText("Email")).performTextInput(u.email)
        compose.onNode(hasSetTextAction() and hasText("Password")).performTextInput("nope-nope-nope")
        compose.onAllNodes(hasText("Log in"))[1].performClick()
        waitFor { hasText("Wrong email or password.") }
    }

    @Test fun `a guest reads an Open Air room and is asked to log in to post`() {
        val u = TestServer.newUser()
        val room = runBlocking { u.api.createRoom("open-${TestServer.uniq()}", chat.android.data.model.Visibility.Open) }
        runBlocking { u.api.send(chat.android.data.api.NewMessage(chat.android.data.lib.newId(), room.id, "hello guests")) }
        start()
        waitFor { hasText("Just looking? Read the Open Air rooms") }
        compose.onNodeWithText("Just looking? Read the Open Air rooms").performScrollTo().performClick()
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        waitFor { hasText("hello guests") }
        compose.onNodeWithText("You're reading as a guest. ").assertIsDisplayed()
    }

    @Test fun `a live message from someone else shows in the open room`() {
        val a = TestServer.newUser()
        val b = TestServer.newUser()
        val room = runBlocking { a.api.createRoom("live-${TestServer.uniq()}") }
        start(a.api.pb.authStore.session.value)
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        waitFor { hasText("Beginning of #${room.name}") }
        runBlocking { b.api.send(chat.android.data.api.NewMessage(chat.android.data.lib.newId(), room.id, "live from b")) }
        waitFor { hasText("live from b") }
    }
}
