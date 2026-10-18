package chat.android

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import chat.android.data.lib.serverLabel
import chat.android.data.testing.TestServer
import chat.android.data.testing.TestServer.newUser
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Several servers and accounts on the screens (ANDROID.md §17). "Another server" is the test server by another address
// (localhost for 127.0.0.1): to the app, two servers.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiAccountsTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)
    private val other = TestServer.url.replace("127.0.0.1", "localhost")

    @After fun tearDown() = ui.stop()

    private fun profile() {
        ui.waitFor(hasContentDescription("Profile"))
        compose.onNodeWithContentDescription("Profile").performClick()
        ui.waitFor("Your profile")
    }

    private fun logIn(u: TestServer.TestUser) {
        compose.onNode(hasSetTextAction() and hasText("Email")).performTextInput(u.email)
        compose.onNode(hasSetTextAction() and hasText("Password")).performTextInput(TestServer.PASSWORD)
        compose.onAllNodes(hasText("Log in"))[1].performScrollTo().performClick()
    }

    @Test fun `add an account on another server, then switch back from your profile`() {
        val u = newUser()
        val v = newUser()
        ui.signedIn(u)
        profile()
        compose.onNodeWithText("Add account").performScrollTo().performClick()
        ui.waitFor("Choose your server")
        compose.onNode(hasSetTextAction() and hasText("Server address")).performTextInput(other)
        compose.onNodeWithText("Continue").performClick()
        ui.waitFor("on ${serverLabel(other)}")
        logIn(v)
        ui.until { ui.services?.store?.get()?.user?.id == v.user.id }
        assertEquals(other, ui.services!!.server)
        ui.waitFor(serverLabel(other)) // under the rooms title: there are two accounts now

        profile()
        ui.waitFor(hasText(u.user.name) and hasClickAction(), merged = true)
        compose.onNode(hasText(u.user.name) and hasClickAction()).performScrollTo().performClick()
        ui.until { ui.services?.store?.get()?.user?.id == u.user.id }
        assertEquals(TestServer.url, ui.services!!.server)
        assertEquals(2, ui.accounts!!.list.value.size)
    }

    @Test fun `an address that isn't a chat server says so`() {
        ui.start()
        ui.waitFor("Just looking? Read the Open Air rooms")
        compose.onNodeWithText("Change server").performClick()
        ui.waitFor("Choose your server")
        compose.onNode(hasSetTextAction() and hasText("Server address")).performTextInput("http://127.0.0.1:1")
        compose.onNodeWithText("Continue").performClick()
        ui.waitFor("Can't reach that server")
        compose.onNodeWithText("Cancel").performClick()
        ui.waitFor("Just looking? Read the Open Air rooms")
        assertEquals(TestServer.url, ui.services!!.server)
    }

    @Test fun `logging out leaves your other accounts a tap away`() {
        val u = newUser()
        val v = newUser()
        ui.startWith(listOf(TestServer.url to u.api.pb.authStore.session.value, other to v.api.pb.authStore.session.value))
        profile()
        compose.onNodeWithText("Log out").performScrollTo().performClick()
        ui.waitFor("Your other accounts")
        ui.waitFor(hasText(v.user.name) and hasClickAction(), merged = true)
        compose.onNode(hasText(v.user.name) and hasClickAction()).performScrollTo().performClick()
        ui.until { ui.services?.store?.get()?.user?.id == v.user.id }
        assertEquals(other, ui.services!!.server)
        // The account logged out of was a guest's on its server, and leaving it forgot it.
        assertEquals(listOf(other), ui.accounts!!.list.value.map { it.server })
    }
}
