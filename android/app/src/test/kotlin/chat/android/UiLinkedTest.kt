package chat.android

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import chat.android.data.model.Visibility
import chat.android.data.testing.TestServer
import chat.android.data.testing.TestServer.newUser
import chat.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Linked instances (DESIGN.md §33.10) on the app's screens. The test server runs the module but is paired with no one:
// what a pairing would set is set by a superuser, and an address on an instance not linked is refused with its reason.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiLinkedTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    @Test fun `a shared room says where else it is held, and its access screen lists people there with their instance`() {
        val a = newUser()
        val b = newUser("bee-${uniq()}")
        val room = runBlocking {
            val r = a.api.createRoom("fed-${uniq()}")
            a.api.setAccess(r.id, Visibility.Private, listOf(a.user.id, b.user.id))
            r
        }
        TestServer.admin("PATCH", "/api/collections/rooms/records/${room.id}", """{"shared":{"with":["b.example"]}}""")
        TestServer.admin("PATCH", "/api/collections/users/records/${b.user.id}", """{"instance":"b.example","no_dms":true}""")
        ui.signedIn(a)
        ui.showRoom(room.name)
        // Its click action, not a tap: scrolled to the bottom edge, the row can be under the New button.
        compose.onNodeWithText(room.name).performSemanticsAction(SemanticsActions.OnClick)
        ui.waitFor("Beginning of #${room.name}")
        ui.waitFor("Shared with b.example")
        compose.onNodeWithContentDescription("Room actions").performClick()
        compose.onNodeWithText("Room access…").performClick()
        ui.waitFor("Shared with b.example: its messages are kept there too. Add people there by their address, like ann@b.example.")
        // Listed, with their instance, though they take no DMs.
        ui.waitFor(b.user.name)
        ui.waitFor(hasText("b.example"))
    }

    @Test fun `New message looks an address up on its instance, and says why it can't`() {
        val a = newUser()
        ui.signedIn(a)
        ui.waitFor("Rooms")
        compose.onNodeWithContentDescription("New").performClick()
        compose.onNodeWithText("New message").performClick()
        compose.onNode(hasSetTextAction()).performTextInput("ann@nowhere.example")
        ui.waitFor("This instance isn't linked to nowhere.example.")
    }
}
