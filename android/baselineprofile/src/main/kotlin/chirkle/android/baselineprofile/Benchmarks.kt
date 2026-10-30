// The §11 budgets that need a device (ANDROID.md §11): cold start, and opening a busy room and scrolling it, each with
// nothing compiled ahead of time and with the Baseline Profile, so the two can be compared.
package chirkle.android.baselineprofile

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule
    val rule = MacrobenchmarkRule()

    @Test
    fun startNotCompiled() = start(CompilationMode.None())

    @Test
    fun startWithProfile() = start(CompilationMode.Partial(BaselineProfileMode.Require))

    /** Cold start to the room list (signed in by the first iteration's setup). */
    private fun start(mode: CompilationMode) = rule.measureRepeated(
        packageName = PACKAGE,
        metrics = listOf(StartupTimingMetric()),
        compilationMode = mode,
        startupMode = StartupMode.COLD,
        iterations = 5,
        setupBlock = { pressHome() },
    ) {
        startActivityAndWait()
        awaitRooms()
    }
}

@RunWith(AndroidJUnit4::class)
class RoomBenchmark {
    @get:Rule
    val rule = MacrobenchmarkRule()

    @Test
    fun roomNotCompiled() = room(CompilationMode.None())

    @Test
    fun roomWithProfile() = room(CompilationMode.Partial(BaselineProfileMode.Require))

    /** Opening the busy room and scrolling back and down, from the room list. */
    private fun room(mode: CompilationMode) = rule.measureRepeated(
        packageName = PACKAGE,
        metrics = listOf(FrameTimingMetric()),
        compilationMode = mode,
        startupMode = StartupMode.WARM,
        iterations = 3,
        setupBlock = {
            pressHome()
            startActivityAndWait()
            awaitRooms()
        },
    ) {
        openRoomAndScroll()
        leaveRoom()
    }
}
