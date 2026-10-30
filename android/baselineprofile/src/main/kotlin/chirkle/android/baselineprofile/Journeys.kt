// What a person does most (ANDROID.md §11): start the app, see the room list, open a busy room and scroll back, as
// UiAutomator steps shared by the Baseline Profile generator and the benchmarks. The account and room come from the
// instrumentation arguments (build.gradle.kts).
package chirkle.android.baselineprofile

import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until

/** The app's id in the benchmark build (app/build.gradle.kts). */
const val PACKAGE = "com.chirkle.android"

/** The dev server as the emulator reaches it, for a first start that asks for one. */
private const val SERVER = "http://10.0.2.2:8090"

/** The emulator here runs without KVM, so every wait is long: an uncompiled cold start takes over a minute there. */
private const val WAIT_MS = 180_000L

private fun arg(name: String) = requireNotNull(InstrumentationRegistry.getArguments().getString(name)) { "no $name argument" }

/**
 * On a slow emulator the system's own apps stop answering now and then, and Android asks whether to wait for them over
 * the app: wait.
 */
private fun UiDevice.dismissNotResponding() {
    if (hasObject(By.textContains("isn't responding"))) findObject(By.text("Wait"))?.click()
}

private fun UiDevice.need(selector: androidx.test.uiautomator.BySelector, what: String): UiObject2 {
    val until = System.currentTimeMillis() + WAIT_MS
    while (true) {
        wait(Until.findObject(selector), 2_000)?.let { return it }
        dismissNotResponding()
        check(System.currentTimeMillis() < until) { "no $what on screen" }
    }
}

/** After a start: signed in, on the room list. Signs in first when the app asks for a server or an account. */
fun MacrobenchmarkScope.awaitRooms() {
    val signedIn = By.desc("Profile")
    val server = By.text("Choose your server")
    val logIn = By.text("Email")
    // Whichever screen the start ends on.
    val until = System.currentTimeMillis() + WAIT_MS
    while (!device.hasObject(signedIn) && !device.hasObject(server) && !device.hasObject(logIn)) {
        check(System.currentTimeMillis() < until) { "the app showed none of its first screens" }
        device.dismissNotResponding()
        device.wait(Until.hasObject(By.pkg(PACKAGE)), 1_000)
    }
    if (device.hasObject(signedIn)) return
    if (device.hasObject(server)) {
        device.need(By.clazz("android.widget.EditText"), "server field").text = SERVER
        device.need(By.text("Continue"), "Continue").click()
    }
    device.need(logIn, "log in form")
    val fields = device.findObjects(By.clazz("android.widget.EditText"))
    fields[0].text = arg("user")
    fields[1].text = arg("password")
    device.findObjects(By.text("Log in")).last().click() // the button, under the tab of the same name
    // A notification permission prompt (Android 13 and later) comes in the way once.
    device.wait(Until.findObject(By.res("com.android.permissioncontroller:id/permission_deny_button")), 3_000)?.click()
    device.need(signedIn, "room list")
}

/** From the room list: open the room, wait for its messages, scroll back through them and down again. */
fun MacrobenchmarkScope.openRoomAndScroll() {
    val name = arg("room")
    var row = device.findObject(By.text(name))
    var tries = 0
    while (row == null && tries++ < 15) {
        device.findObject(By.scrollable(true))?.scroll(Direction.DOWN, 0.8f)
        row = device.wait(Until.findObject(By.text(name)), 1_000)
    }
    requireNotNull(row) { "no room $name in the list" }.click()
    val messages = device.need(By.desc("Messages"), "messages")
    device.wait(Until.hasObject(By.desc("Messages").hasChild(By.clickable(true))), WAIT_MS)
    messages.setGestureMargin(device.displayWidth / 5)
    // Newest at the bottom: older ones are above.
    repeat(4) {
        messages.fling(Direction.UP)
        device.waitForIdle()
    }
    repeat(4) {
        messages.fling(Direction.DOWN)
        device.waitForIdle()
    }
}

/** Back to the room list. */
fun MacrobenchmarkScope.leaveRoom() {
    device.pressBack()
    device.need(By.desc("Profile"), "room list")
}
