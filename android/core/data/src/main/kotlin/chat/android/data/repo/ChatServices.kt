// Everything the screens use, built once (ANDROID.md §4, §5: a hand-written graph, no DI framework). Owns the session:
// starts the services for whoever is logged in (or a guest, §23.3), and on a change of user stops them and clears what
// belonged to the last one (ANDROID.md §10).
package chat.android.data.repo

import chat.android.data.api.ApiError
import chat.android.data.api.ChatApi
import chat.android.data.db.ChatDatabase
import chat.android.data.model.User
import chat.android.data.pb.AuthStore
import chat.android.data.pb.PbClient
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/** What the app does around the session that core:data can't: notifications, image caches, push, background work. */
interface SessionHooks {
    /** Someone logged in (or the app started with a session): register for pushes. */
    suspend fun onSignedIn(user: User) {}

    /** Before the session ends, with it still valid: unregister the push token. */
    suspend fun beforeSignOut() {}

    /** The session ended or changed hands: clear notifications, image caches, the launcher badge. */
    suspend fun onSignedOut() {}

    /** Ask WorkManager to send the outbox. */
    fun scheduleOutbox() {}
}

class ChatServices(
    serverUrl: String,
    http: OkHttpClient,
    val authStore: AuthStore,
    val db: ChatDatabase,
    /** The main thread: every service and controller runs there, as the web app runs on its one thread. */
    val main: CoroutineDispatcher,
    private val hooks: SessionHooks = object : SessionHooks {},
    /** The account these services are (ANDROID.md §17): names its notifications, work and files. */
    val accountId: String = "",
    /** The device's settings, shared by its accounts; without, kept in [db]. */
    settings: DeviceSettings? = null,
) {
    /** Lives as long as the process: writes (sends, edits, reads) outlive the screen that made them. */
    val appScope = CoroutineScope(SupervisorJob() + main)

    val pb = PbClient(serverUrl, http, authStore)

    /** The server's address, as the account has it (`https://host[/path]`). */
    val server: String = pb.base.toString().trimEnd('/')
    val api = ChatApi(pb)
    val store = Store()
    val tokens = FileTokens(api, appScope)
    val cache = RoomCache(db, appScope)
    val drafts = Drafts(db, appScope)
    val site = SiteRepository(api, db, store)
    val rooms = RoomsSync(api, store, db, main)
    val unread = Unread(api, store, db, main)
    val prefetch = Prefetch(api, store, cache, main)
    val outbox = Outbox(api, db, appScope) { hooks.scheduleOutbox() }
    val actions = RoomActions(api, store)
    val recentEmoji = RecentEmoji(db, appScope)
    val settings = settings ?: DeviceSettings(db, appScope)

    private var who: String? = null
    private var backgroundJob: Job? = null

    /** Show what was kept, then start the session's services (call once, with the stored session loaded). */
    suspend fun start() = withContext(main) {
        site.loadCached()
        recentEmoji.load()
        settings.load()
        appScope.launch { site.refresh() }
        sessionChanged()
        appScope.launch { authStore.session.collect { sessionChanged() } }
        // Renew the session after launch, off the critical path; one the server refuses ends here.
        appScope.launch { checkSession() }
        api.onRejected { appScope.launch { checkSession() } }
    }

    private suspend fun sessionChanged() {
        val user = api.currentUser()
        val id = user?.id.orEmpty()
        if (id == who) {
            if (user != null && user != store.get().user) store.update { it.copy(user = user) }
            return
        }
        val first = who == null
        who = id
        unread.stop()
        prefetch.stop()
        rooms.stop()
        tokens.reset()
        if (!first) {
            // Nothing of the last session may show for the next person (ANDROID.md §10).
            cache.clearMemory()
            db.clearSession()
            outbox.clear()
            recentEmoji.clear()
            hooks.onSignedOut()
            store.update { AppStateForSite(it) }
        }
        store.update { it.copy(user = user) }
        if (first) {
            rooms.loadSaved()
            if (user != null) unread.loadSaved()
        }
        rooms.start()
        if (user != null) {
            unread.start()
            prefetch.start()
            outbox.drain()
            appScope.launch { runCatching { hooks.onSignedIn(user) } }
        }
    }

    /** Check the session with the server (which renews it); end it when refused. */
    private suspend fun checkSession() {
        if (api.currentUser() == null) return
        try {
            api.refreshAuth()
        } catch (e: ApiError) {
            if (e.status == 401 || e.status == 403 || e.status == 404) logOut()
        }
    }

    suspend fun logIn(email: String, password: String): User = api.logIn(email, password)

    suspend fun signUp(email: String, password: String, name: String, inviteCode: String = ""): User = api.signUp(email, password, name, inviteCode)

    /** Send what was read, unregister pushes, then end the session; everything of it is cleared. */
    suspend fun logOut() = withContext(main) {
        unread.flush()
        runCatching { hooks.beforeSignOut() }
        api.logOut()
    }

    /** The app came to the foreground or went to the background (ANDROID.md §9.1, DESIGN.md §22.4). */
    fun setVisible(visible: Boolean) {
        appScope.launch {
            store.update { it.copy(away = !visible) }
            backgroundJob?.cancel()
            if (visible) pb.realtime.resume()
            else backgroundJob = appScope.launch {
                delay(BACKGROUND_CLOSE_MS)
                pb.realtime.pause()
            }
        }
    }

    /** The room screen opened [roomId] (around [msgId]): its controller, started. [RoomController.close] ends it. */
    fun openRoom(roomId: String, msgId: String? = null): RoomController {
        store.update { it.copy(activeRoomId = roomId) }
        return RoomController(api, store, outbox, cache, tokens, roomId, msgId, main, appScope).also { it.start() }
    }

    /** The room screen closed: no room is active (if it still was this one). */
    fun closeRoom(roomId: String) {
        store.update { if (it.activeRoomId == roomId) it.copy(activeRoomId = null) else it }
    }

    /** Another account became active: send what was read, then stop. */
    suspend fun stop() = withContext(main) {
        runCatching { unread.flush() }
        close()
    }

    /** Stop everything (tests; the process ending needs nothing). */
    suspend fun close() = withContext(main) {
        unread.stop()
        prefetch.stop()
        rooms.stop()
        pb.realtime.unsubscribeAll()
        appScope.coroutineContext[Job]?.cancel()
    }

    private companion object {
        /** The realtime connection closes this long after the app goes to the background. */
        const val BACKGROUND_CLOSE_MS = 5000L

        /** What stays when the session ends: the site record and whether the app is visible. */
        fun AppStateForSite(s: AppState) = AppState(site = s.site, away = s.away)
    }
}
