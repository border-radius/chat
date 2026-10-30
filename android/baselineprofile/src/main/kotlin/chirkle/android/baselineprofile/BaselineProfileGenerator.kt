// Generates the app's Baseline Profile (ANDROID.md §11): the code of starting, the room list, opening a room and
// scrolling, compiled ahead of time on install so it isn't interpreted at first use. Kept as
// app/src/main/baseline-prof.txt (build.gradle.kts says how).
package chirkle.android.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(packageName = PACKAGE, maxIterations = 3, stableIterations = 2, includeInStartupProfile = true) {
        pressHome()
        startActivityAndWait()
        awaitRooms()
        openRoomAndScroll()
        leaveRoom()
    }
}
