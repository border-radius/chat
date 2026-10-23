package chat.android

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import chat.android.data.api.NewMessage
import chat.android.data.lib.newId
import chat.android.data.pb.UploadFile
import chat.android.data.repo.ThemeChoice
import chat.android.data.testing.TestServer.newUser
import chat.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Web features ported after the app was unfrozen (2026-10-23): Jump to (§32), the media grid (§30), Appearance (§7.8).
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiPortsTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    /** A 1×1 PNG. */
    private val png = byteArrayOf(
        -119, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, -60, -119, 0, 0, 0, 13, 73,
        68, 65, 84, 120, -38, 99, -8, -1, -1, 63, 0, 5, -2, 2, -2, -89, 53, -127, -124, 0, 0, 0, 0, 73, 69, 78, 68, -82, 66, 96, -126,
    )

    @Test fun `jump to finds a room by a word of its name (switcher spec)`() {
        val a = newUser()
        val tag = uniq()
        val room = runBlocking { a.api.createRoom("jump-$tag-target") }
        ui.signedIn(a)
        ui.showRoom(room.name)
        compose.onNodeWithContentDescription("Jump to a room or person").performClick()
        compose.onNode(hasSetTextAction() and hasContentDescription("Jump to")).performTextInput("#$tag")
        ui.waitFor(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("Beginning of #${room.name}")
    }

    @Test fun `the media grid shows a room's images and opens the viewer (media spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("md-${uniq()}") }
        runBlocking { a.api.send(NewMessage(newId(), room.id, "a picture", listOf(UploadFile("dot.png", "image/png", png.toRequestBody("image/png".toMediaType()))))) }
        ui.signedIn(a)
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("a picture")
        compose.onNodeWithContentDescription("Media").performClick()
        ui.waitFor(hasContentDescription("dot.png", substring = true))
        compose.onNode(hasContentDescription("dot.png", substring = true)).performClick()
        ui.waitFor(hasContentDescription("Download"))
    }

    @Test fun `an empty room's media grid says so`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("me-${uniq()}") }
        ui.signedIn(a)
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("Beginning of #${room.name}")
        compose.onNodeWithContentDescription("Media").performClick()
        ui.waitFor("No photos or videos here yet.")
    }

    @Test fun `the appearance can be set to dark and is kept (theme spec)`() {
        val a = newUser()
        val services = ui.signedIn(a)
        ui.waitFor(hasContentDescription("Profile"))
        compose.onNodeWithContentDescription("Profile").performClick()
        ui.waitFor("Appearance")
        compose.onNodeWithText("Dark").performScrollTo().performClick()
        ui.until { services.settings.theme.value == ThemeChoice.Dark }
        assertEquals(ThemeChoice.Dark, services.settings.theme.value)
    }

    @Test fun `text shared into the app goes to the chosen room, and the picker stays closed`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("sh-${uniq()}") }
        chat.android.nav.ShareInbox.pending = chat.android.nav.Shared("shared text", emptyList())
        try {
            ui.signedIn(a)
            ui.waitFor("Share to")
            ui.showRoom(room.name, "#${room.name}")
            compose.onNodeWithText("#${room.name}").performClick()
            ui.waitFor("Beginning of #${room.name}")
            ui.waitFor("shared text")
            ui.waitGone("Share to")
        } finally {
            chat.android.nav.ShareInbox.pending = null
        }
    }
}
