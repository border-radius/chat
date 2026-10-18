package chat.android

import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.printToString
import chat.android.data.pb.Session
import chat.android.data.repo.Accounts
import chat.android.data.repo.ChatServices
import chat.android.data.testing.MemoryAccountEnv
import chat.android.data.testing.TestServer
import chat.android.nav.AppRoot
import chat.android.ui.ChatTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * The app on [compose], as MainActivity shows it: accounts of its own (ANDROID.md §17) against the test server, the
 * first signed in as [session].
 */
class UiHarness(private val compose: ComposeContentTestRule) {
    var accounts: Accounts? = null

    /** The active account's services. */
    val services: ChatServices? get() = accounts?.active?.value

    fun start(session: Session = Session.NONE): ChatServices = startWith(listOf(TestServer.url to session))

    /** Accounts on [servers] (server and session each), the first active. */
    fun startWith(servers: List<Pair<String, Session>>): ChatServices {
        val a = Accounts(MemoryAccountEnv(servers), OkHttpClient(), Dispatchers.Main.immediate, TestServer.url, allowHttp = true)
        accounts = a
        // The test runs on the main thread: started there, and driven by the rule's idling (never blocked on).
        a.scope.launch { a.start() }
        compose.setContent { ChatTheme { AppRoot(a, linked = null, onLinkTaken = {}, onSignedIn = {}) } }
        compose.waitUntil(15_000) { pump(); a.active.value != null }
        return a.active.value!!
    }

    fun signedIn(u: TestServer.TestUser) = start(u.api.pb.authStore.session.value)

    fun stop() {
        accounts?.let { a -> a.scope.launch { a.close() } }
        compose.waitForIdle()
    }

    /** Wait for a node [matcher] matches; [merged]: as the screen reader sees nodes (a row's text with its click). */
    fun waitFor(matcher: SemanticsMatcher, ms: Long = 15_000, merged: Boolean = false) = dumping {
        compose.waitUntil(ms) {
            pump()
            compose.onAllNodes(matcher, useUnmergedTree = !merged).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /**
     * Run the main looper and move its clock on: on Robolectric's paused looper, time stands still unless a test moves
     * it, so the app's delays (search's debounce, read batching, draft saves) would never end, and waitUntil itself
     * doesn't run the looper at all.
     */
    fun pump() {
        org.robolectric.shadows.ShadowLooper.idleMainLooper(PUMP_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        compose.waitForIdle()
    }

    /** Print what is on screen (texts and descriptions), for debugging a test. */
    fun dump(label: String) {
        println("---- $label ----")
        runCatching {
            val r = compose.onAllNodes(androidx.compose.ui.test.isRoot())
            println((0 until r.fetchSemanticsNodes().size).joinToString("\n") { r[it].printToString(Int.MAX_VALUE) }.lines().filter { "Text =" in it || "ContentDescription" in it }.joinToString("\n"))
        }
    }

    /** [block], and what was on screen when it timed out (in the test's output). */
    private fun dumping(block: () -> Unit) {
        try {
            block()
        } catch (e: androidx.compose.ui.test.ComposeTimeoutException) {
            println("---- screen at timeout ----")
            runCatching { println(compose.onAllNodes(androidx.compose.ui.test.isRoot()).let { r -> (0 until r.fetchSemanticsNodes().size).joinToString("\n") { r[it].printToString(Int.MAX_VALUE) } }) }
            throw e
        }
    }

    fun waitFor(text: String, ms: Long = 15_000) = waitFor(hasText(text, substring = true), ms)

    fun waitGone(text: String, ms: Long = 15_000) {
        compose.waitUntil(ms) { pump(); compose.onAllNodes(hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    /**
     * Wait for room [name] in the room list and bring its row into view: the test server is shared, so the list holds
     * every test's public rooms, and a lazy list composes only the rows on screen.
     */
    fun showRoom(name: String) {
        compose.waitUntil(15_000) { pump(); services?.store?.get()?.let { s -> s.roomsStatus == chat.android.data.repo.LoadStatus.Ready && s.rooms.values.any { it.name == name } } == true }
        // The list, not another scrolling screen still on its way out (Log in scrolls too).
        compose.waitUntil(15_000) {
            pump()
            val lists = compose.onAllNodes(androidx.compose.ui.test.hasScrollAction())
            (0 until lists.fetchSemanticsNodes().size).any { i -> runCatching { lists[i].performScrollToNode(hasText(name)) }.isSuccess }
        }
    }

    /** Wait until the server says so (polling). */
    fun until(ms: Long = 15_000, check: suspend () -> Boolean) = dumping {
        compose.waitUntil(ms) {
            pump()
            kotlinx.coroutines.runBlocking { runCatching { check() }.getOrDefault(false) }
        }
    }

    private companion object {
        const val PUMP_MS = 50L
    }
}
