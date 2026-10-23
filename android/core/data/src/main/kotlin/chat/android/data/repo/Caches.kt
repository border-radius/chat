// Small services: file tokens (§17.3), the room cache (§7.5), drafts (§22.3), the site record (§24).
package chat.android.data.repo

import chat.android.data.api.ChatApi
import chat.android.data.db.ChatDatabase
import chat.android.data.db.DraftEntity
import chat.android.data.db.KeptEntity
import chat.android.data.db.Keys
import chat.android.data.db.KvEntity
import chat.android.data.model.Message
import chat.android.data.model.Room
import chat.android.data.model.Site
import chat.android.data.pb.PbJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Protected attachments need a short-lived token in their URL (§17.3): one kept fresh, one request shared. */
class FileTokens(private val api: ChatApi, private val scope: CoroutineScope, private val now: () -> Long = System::currentTimeMillis) {
    @Volatile private var token = ""
    @Volatile private var at = 0L
    private var inflight: Deferred<String>? = null
    private var generation = 0

    val current: String get() = token

    fun fresh(): Boolean = token.isNotEmpty() && now() - at < MAX_AGE_MS

    /** A fresh token: the cached one, the one being fetched, or ([force]) a new one. "" for a guest. */
    @Synchronized
    fun ensureAsync(force: Boolean = false): Deferred<String> {
        if (!force && fresh()) return CompletableDeferred(token)
        inflight?.let { if (it.isActive) return it }
        val gen = generation
        val started = now()
        val d = scope.async {
            val t = api.newFileToken()
            synchronized(this@FileTokens) {
                if (gen == generation) {
                    token = t
                    at = started
                }
            }
            t
        }
        inflight = d
        return d
    }

    suspend fun ensure(force: Boolean = false): String = ensureAsync(force).await()

    /** Forget the token (the user changed). */
    @Synchronized
    fun reset() {
        generation++
        token = ""
        at = 0
        inflight = null
    }

    companion object {
        /** PocketBase's tokens last 3 minutes; renewed after 2. */
        const val MAX_AGE_MS = 120_000L
    }
}

/** A room's latest messages as the user last saw them (web/src/cache.ts). */
@Serializable
data class Kept(
    val items: List<Message>,
    val hasOlder: Boolean,
    /** The room itself, so its header shows before the room list is in. */
    val room: Room? = null,
    /** Prefetched: the room's unread count when the page was asked for. */
    val unread: Int? = null,
)

/**
 * Each room's latest page, in the database and, once read or written, in memory: switching back to a room shows it in
 * the same frame. One user's at a time; cleared when the session ends.
 */
class RoomCache(private val db: ChatDatabase, private val scope: CoroutineScope) {
    private val mem = HashMap<String, Pair<String, Kept>>()

    suspend fun get(user: String, room: String): Kept? {
        synchronized(mem) { mem[room] }?.let { (u, k) -> return k.takeIf { u == user } }
        val row = db.kept().get(room) ?: return null
        if (row.user != user) return null
        val kept = runCatching { PbJson.decodeFromString(Kept.serializer(), row.json) }.getOrNull() ?: return null
        synchronized(mem) { mem.putIfAbsent(room, user to kept) }
        return kept
    }

    /** Synchronously: what is in memory for the room, if anything. */
    fun peek(user: String, room: String): Kept? = synchronized(mem) { mem[room] }?.takeIf { it.first == user }?.second

    fun put(user: String, room: String, kept: Kept) {
        synchronized(mem) { mem[room] = user to kept }
        scope.launch {
            db.kept().put(KeptEntity(room, user, PbJson.encodeToString(Kept.serializer(), kept), System.currentTimeMillis()))
            db.kept().trim(MAX_ROOMS)
        }
    }

    fun clearMemory() = synchronized(mem) { mem.clear() }

    companion object {
        /** Rooms kept on the device: the ones opened most recently (ANDROID.md §6.2). */
        const val MAX_ROOMS = 30
    }
}

/** Unsent composer text per user and room (§22.3), and the message it replies to. */
class Drafts(private val db: ChatDatabase, private val scope: CoroutineScope) {
    data class Draft(val text: String, val replyTo: String)

    suspend fun get(user: String, room: String): Draft? =
        if (user.isEmpty()) null else db.drafts().get(user, room)?.let { Draft(it.text, it.replyTo) }

    /** Blank text without a reply removes the draft. */
    fun set(user: String, room: String, text: String, replyTo: String = "") {
        if (user.isEmpty()) return
        scope.launch {
            if (text.isBlank() && replyTo.isEmpty()) db.drafts().delete(user, room) else db.drafts().put(DraftEntity(user, room, text, replyTo))
        }
    }
}

/** The site's branding and signup policy (§24): the last one seen at once, then the server's. */
class SiteRepository(private val api: ChatApi, private val db: ChatDatabase, private val store: Store) {
    suspend fun loadCached() {
        val cached = db.kv().get(Keys.SITE)?.let { runCatching { PbJson.decodeFromString(Site.serializer(), it) }.getOrNull() } ?: return
        store.update { it.copy(site = cached) }
    }

    /** Fetch the site record; failing keeps what is shown. */
    suspend fun refresh() {
        val site = runCatching { api.site() }.getOrNull() ?: return
        store.update { it.copy(site = site) }
        if (site == Site.DEFAULT) db.kv().delete(Keys.SITE) else db.kv().put(KvEntity(Keys.SITE, PbJson.encodeToString(Site.serializer(), site)))
    }
}

/** Recently picked emoji, newest first (§20.4), kept on the device; only the picker's emoji. */
class RecentEmoji(private val db: ChatDatabase, private val scope: CoroutineScope) {
    private val state = kotlinx.coroutines.flow.MutableStateFlow<List<String>>(emptyList())
    val list: kotlinx.coroutines.flow.StateFlow<List<String>> = state

    suspend fun load() {
        val saved = db.kv().get(Keys.RECENT_EMOJI) ?: return
        state.value = saved.split(' ').filter { it in chat.android.data.lib.EMOJI }.take(chat.android.data.lib.RECENT_MAX)
    }

    fun remember(emoji: String) {
        if (emoji !in chat.android.data.lib.EMOJI) return
        state.value = (listOf(emoji) + state.value.filter { it != emoji }).take(chat.android.data.lib.RECENT_MAX)
        val v = state.value.joinToString(" ")
        scope.launch { db.kv().put(KvEntity(Keys.RECENT_EMOJI, v)) }
    }

    fun clear() {
        state.value = emptyList()
    }
}

/** The app's theme (the web's Appearance choice, DESIGN.md §7.8): the system's, or always light or dark. */
enum class ThemeChoice(val label: String) {
    System("System"), Light("Light"), Dark("Dark");

    companion object {
        fun of(v: String?) = entries.firstOrNull { it.name.equals(v, ignoreCase = true) } ?: System
    }
}

/**
 * This device's settings, kept across sessions: whether screens with messages are kept out of screenshots (§10), the
 * theme, and which room list sections are folded (the web keeps those in localStorage). [read] and [write] take a key of [Keys].
 */
class DeviceSettings(private val read: suspend (String) -> String?, private val write: suspend (String, String) -> Unit, private val scope: CoroutineScope) {
    /** Kept in [db] (tests, and services without accounts). */
    constructor(db: ChatDatabase, scope: CoroutineScope) : this({ db.kv().get(it) }, { k, v -> db.kv().put(KvEntity(k, v)) }, scope)

    private val secureState = kotlinx.coroutines.flow.MutableStateFlow(false)
    val secureScreens: kotlinx.coroutines.flow.StateFlow<Boolean> = secureState
    private val themeState = kotlinx.coroutines.flow.MutableStateFlow(ThemeChoice.System)
    val theme: kotlinx.coroutines.flow.StateFlow<ThemeChoice> = themeState
    private val foldedState = kotlinx.coroutines.flow.MutableStateFlow(emptySet<String>())
    /** The room list's folded sections: only their unread rows (and the open one) are listed. */
    val folded: kotlinx.coroutines.flow.StateFlow<Set<String>> = foldedState

    suspend fun load() {
        secureState.value = read(Keys.SECURE_SCREENS) == "1"
        themeState.value = ThemeChoice.of(read(Keys.THEME))
        foldedState.value = read(Keys.FOLDED).orEmpty().split(' ').filter { it.isNotEmpty() }.toSet()
    }

    fun setSecureScreens(on: Boolean) {
        secureState.value = on
        scope.launch { write(Keys.SECURE_SCREENS, if (on) "1" else "0") }
    }

    fun toggleFolded(section: String) {
        val now = foldedState.value.let { if (section in it) it - section else it + section }
        foldedState.value = now
        scope.launch { write(Keys.FOLDED, now.joinToString(" ")) }
    }

    fun setTheme(t: ThemeChoice) {
        themeState.value = t
        scope.launch { write(Keys.THEME, t.name.lowercase()) }
    }
}
