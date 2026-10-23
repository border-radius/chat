package chat.android.data.testing

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import chat.android.data.db.ChatDatabase
import chat.android.data.pb.MemoryAuthStore
import chat.android.data.repo.ChatServices
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.Executors

private val open = mutableListOf<ChatServices>()

/** Close the services the last test made (call from @After). */
fun closeServices() = runBlocking {
    open.forEach { it.close() }
    open.clear()
}

/** An empty in-memory database, as the services use. */
fun testDb(): ChatDatabase =
    Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ChatDatabase::class.java).allowMainThreadQueries().build()

/**
 * The app's services against the test server, as [user] (null: a guest), on a main thread of their own. [session]:
 * the stored session instead of [user]'s; [db]: one with data in it already.
 */
fun services(
    user: TestServer.TestUser?,
    session: chat.android.data.pb.Session? = null,
    db: ChatDatabase = testDb(),
): ChatServices {
    val auth = MemoryAuthStore(session ?: user?.api?.pb?.authStore?.session?.value ?: chat.android.data.pb.Session.NONE)
    val main = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main").apply { isDaemon = true } }.asCoroutineDispatcher()
    return ChatServices(TestServer.url, TestServer.http, auth, db, main).also {
        open += it
        runBlocking { it.start() }
    }
}

/** Wait until [check] holds (polling), or fail after [ms]. */
suspend fun eventually(ms: Long = 10_000, what: String = "condition", check: () -> Boolean) {
    try {
        withTimeout(ms) { while (!check()) delay(25) }
    } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
        throw AssertionError("timed out waiting for $what")
    }
}
