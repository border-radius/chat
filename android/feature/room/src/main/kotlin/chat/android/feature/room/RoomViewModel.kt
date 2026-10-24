// One room screen's state (ANDROID.md §7): the controller's window as list rows, the composer (draft, reply, edit,
// attachments), selection (§21), search (§29) and what has been read (§18.3).
package chat.android.feature.room

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import chat.android.data.api.reasonOf
import chat.android.data.lib.Limits
import chat.android.data.lib.MessageOrder
import chat.android.data.lib.PAGE_SIZE
import chat.android.data.lib.Pages
import chat.android.data.lib.checkFiles
import chat.android.data.lib.isBlank
import chat.android.data.lib.otherMember
import chat.android.data.lib.searchQuery
import chat.android.data.lib.searchWords
import chat.android.data.lib.startsGroup
import chat.android.data.lib.textLength
import chat.android.data.model.Cursor
import chat.android.data.model.LocalFile
import chat.android.data.model.Message
import chat.android.data.repo.ChatServices
import chat.android.data.repo.RoomController
import chat.android.data.repo.RoomReader
import chat.android.data.repo.RoomState
import chat.android.ui.Formats
import chat.android.ui.ImagePrep
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/** A row of the message list, newest first (the list is laid out from the bottom). */
sealed interface ListRow {
    val key: String

    data class Msg(val m: Message, val first: Boolean, val target: Boolean) : ListRow {
        override val key get() = m.id
    }

    data class Day(val label: String, override val key: String) : ListRow

    /** The line over the first message that was unread (§18.5). */
    data object NewLine : ListRow {
        override val key = "new-line"
    }

    /** The start of the room's history. */
    data class Beginning(val text: String) : ListRow {
        override val key = "beginning"
    }
}

class RoomViewModel(
    private val app: Application,
    val services: ChatServices,
    val roomId: String,
    msgId: String?,
) : ViewModel() {
    val controller: RoomController = services.openRoom(roomId, msgId)
    private val reader: RoomReader? = if (services.store.get().user != null) services.unread.open(roomId) else null
    private val me get() = services.store.get().user?.id.orEmpty()

    /** The list's rows, newest first, built off the composition. */
    val rows: StateFlow<List<ListRow>> = controller.state.map { s -> buildRows(s) }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    // ---- composer (§7.2, §22.3)

    var text by mutableStateOf(TextFieldValue(""))
        private set
    var replyTo by mutableStateOf<Message?>(null)
        private set
    var editing by mutableStateOf<Message?>(null)
        private set
    var attachments by mutableStateOf<List<LocalFile>>(emptyList())
        private set
    /** Collection items picked to attach (DESIGN.md §31.3): sent after the files, as the server attaches them. */
    var items by mutableStateOf<List<chat.android.data.model.CollectionItem>>(emptyList())
        private set
    /** What the "from collection" badges of the room's files say (§31.3), asked once while the room is open. */
    val badges = chat.android.data.repo.Badges(services.api, viewModelScope)
    /** A problem with what is being written ("" for none). */
    var composerError by mutableStateOf("")
        private set
    /** A passing message (a failed reaction, forward, delete): shown once. */
    var toast by mutableStateOf<String?>(null)
    private var draftJob: Job? = null
    private var savedText: TextFieldValue? = null

    init {
        services.opened.note(roomId)
        viewModelScope.launch {
            val d = services.drafts.get(me, roomId) ?: return@launch
            if (text.text.isEmpty()) text = TextFieldValue(d.text, TextRange(d.text.length))
            if (d.replyTo.isNotEmpty()) waitForReply(d.replyTo)
        }
    }

    /** The draft's reply target, once the window has it. */
    private suspend fun waitForReply(id: String) {
        repeat(50) {
            controller.find(id)?.let { if (replyTo == null && editing == null) replyTo = it; return }
            delay(100)
        }
    }

    fun onText(v: TextFieldValue) {
        text = v
        composerError = ""
        if (editing == null) saveDraft()
    }

    private fun saveDraft() {
        draftJob?.cancel()
        draftJob = viewModelScope.launch {
            delay(300)
            services.drafts.set(me, roomId, text.text, replyTo?.id.orEmpty())
        }
    }

    fun insert(emoji: String) {
        val t = text
        val start = minOf(t.selection.start, t.selection.end)
        val end = maxOf(t.selection.start, t.selection.end)
        onText(TextFieldValue(t.text.substring(0, start) + emoji + t.text.substring(end), TextRange(start + emoji.length)))
    }

    fun reply(m: Message) {
        if (!controller.repliable(m)) return
        if (editing != null) cancelEdit()
        replyTo = m
        saveDraft()
    }

    fun cancelReply() {
        replyTo = null
        saveDraft()
    }

    fun startEdit(m: Message) {
        if (!controller.editable(m)) return
        if (editing == null) savedText = text
        replyTo = null
        editing = m
        text = TextFieldValue(m.text, TextRange(m.text.length))
        composerError = ""
    }

    fun cancelEdit() {
        editing = null
        text = savedText ?: TextFieldValue("")
        savedText = null
        composerError = ""
    }

    /** Edit my newest message (Up in an empty composer, as on the web). */
    fun editLast(): Boolean {
        if (text.text.isNotEmpty() || editing != null) return false
        controller.lastEditable()?.let { startEdit(it); return true }
        return false
    }

    /** Pick the message above or below the one replied to (Ctrl+Up/Down, as on the web). */
    fun moveReply(up: Boolean) {
        val items = controller.state.value.items.filter { controller.repliable(it) }
        if (items.isEmpty()) return
        val i = replyTo?.let { r -> items.indexOfFirst { it.id == r.id } } ?: -1
        val next = when {
            i < 0 -> if (up) items.last() else null
            up -> items.getOrNull(i - 1) ?: items[i]
            else -> items.getOrNull(i + 1)
        }
        if (next == null) cancelReply() else reply(next)
    }

    private fun tooLong(s: String): String? {
        val n = textLength(s)
        return if (n > Limits.MESSAGE_TEXT) "Too long: ${n - Limits.MESSAGE_TEXT} characters over the ${Limits.MESSAGE_TEXT} limit." else null
    }

    /** Send what is written (or save the edit). */
    fun submit() {
        val body = text.text
        editing?.let { m ->
            if (isBlank(body)) return run { composerError = "A message can't be empty. Use Delete to remove it." }
            tooLong(body)?.let { return run { composerError = it } }
            val saved = controller.edit(m.id, body.trim())
            cancelEdit()
            viewModelScope.launch { if (saved?.await() == false) toast = "Couldn't save your edit." }
            return
        }
        if (isBlank(body) && attachments.isEmpty() && items.isEmpty()) return
        tooLong(body)?.let { return run { composerError = it } }
        if (!controller.send(body.trim(), attachments, replyTo, items)) return
        text = TextFieldValue("")
        attachments = emptyList()
        items = emptyList()
        replyTo = null
        draftJob?.cancel()
        services.drafts.set(me, roomId, "", "")
    }

    /** Picked files: copied into app storage (the outbox sends them from there, even after a restart). */
    fun attach(uris: List<Uri>) {
        viewModelScope.launch {
            val dir = File(app.filesDir, "outbox/${services.accountId}/${UUID.randomUUID()}").apply { mkdirs() }
            val picked = withContext(Dispatchers.IO) { uris.mapNotNull { copy(it, dir) } }
            val check = checkFiles(attachments.size + items.size, picked, { it.name }, { it.size })
            for (f in picked - check.accepted.toSet()) File(f.uri).delete()
            attachments = attachments + check.accepted
            composerError = check.rejected.joinToString(" ") { (name, why) -> "“$name” wasn't added: $why." }
        }
    }

    /** How many more files the message takes. */
    val filesLeft: Int get() = (Limits.ATTACHMENTS - attachments.size - items.size).coerceAtLeast(0)

    /** Items picked from a collection join the tray (each once, as many as the message still takes). */
    fun attachItems(picked: List<chat.android.data.model.CollectionItem>) {
        val have = items.map { it.id }.toSet()
        items = items + picked.filter { it.id !in have }.take(filesLeft)
        composerError = ""
    }

    fun removeItem(it: chat.android.data.model.CollectionItem) {
        items = items - it
    }

    fun removeAttachment(f: LocalFile) {
        attachments = attachments - f
        File(f.uri).delete()
    }

    private fun copy(uri: Uri, dir: File): LocalFile? = runCatching {
        val cr = app.contentResolver
        var name = "file"
        var size = -1L
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(0) ?: name
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        val type = cr.getType(uri) ?: "application/octet-stream"
        // Too big to send: not copied at all.
        if (size > Limits.ATTACHMENT_BYTES) return LocalFile("", name, type, size)
        val safe = name.replace(Regex("[/\\\\\u0000]"), "_").ifBlank { "file" }
        val out = generateSequence(File(dir, safe)) { File(dir, "${it.nameWithoutExtension}-1.${it.extension}") }.first { !it.exists() }
        cr.openInputStream(uri)!!.use { input -> out.outputStream().use { input.copyTo(it) } }
        // Photos are scaled down and re-encoded, which drops their EXIF (GPS location, §15.3).
        ImagePrep.prepare(out, name, type, ImagePrep.ATTACHMENT_EDGE)?.let { (file, n, t) ->
            out.delete()
            return LocalFile(file.path, n, t, file.length())
        }
        LocalFile(out.path, name, type, out.length())
    }.getOrNull()

    // ---- selection (§21)

    var selected by mutableStateOf<Set<String>>(emptySet())
        private set
    val selecting get() = selected.isNotEmpty()

    fun toggleSelect(m: Message) {
        if (!controller.selectable(m)) return
        selected = when {
            m.id in selected -> selected - m.id
            selected.size >= Limits.MAX_SELECTED -> {
                toast = "You can select up to ${Limits.MAX_SELECTED} messages at a time."
                selected
            }
            else -> selected + m.id
        }
    }

    fun clearSelection() {
        selected = emptySet()
    }

    /** Can every selected message be deleted by me? */
    val canDeleteSelected: Boolean get() = selected.isNotEmpty() && selected.all { id -> controller.find(id)?.let { controller.deletable(it) } == true }

    fun deleteSelected() {
        val ids = selected.toList()
        val done = controller.removeMany(ids) ?: return
        selected = emptySet()
        viewModelScope.launch { done.await()?.let { toast = "Couldn't delete those messages. ${reasonOf(it)}" } }
    }

    /** Forward [ids] into [room] (§21.3); the copies are mine and say who first wrote them. */
    fun forward(ids: List<String>, room: String, then: (String) -> Unit) {
        val ordered = ids.mapNotNull { controller.find(it) }.sortedWith(MessageOrder).map { it.id }
        viewModelScope.launch {
            runCatching { services.api.forward(ordered, room) }
                .onSuccess {
                    selected = emptySet()
                    toast = if (ordered.size == 1) "Message forwarded." else "${ordered.size} messages forwarded."
                    then(room)
                }
                .onFailure { toast = "Couldn't forward. ${reasonOf(it)}" }
        }
    }

    // ---- reactions (§20)

    fun react(m: Message, emoji: String) {
        val mine = controller.reactions(m).any { it.emoji == emoji && me in it.users }
        val done = controller.react(m.id, emoji, !mine) ?: return
        viewModelScope.launch { if (!done.await()) toast = if (mine) "Couldn't remove your $emoji reaction." else "Couldn't add your $emoji reaction." }
        services.recentEmoji.remember(emoji)
    }

    fun delete(m: Message) {
        val done = controller.remove(m.id) ?: return
        viewModelScope.launch { if (!done.await()) toast = "Couldn't delete this message." }
    }

    // ---- search (§29)

    var searching by mutableStateOf(false)
        private set
    var query by mutableStateOf("")
        private set
    var results by mutableStateOf<List<Message>>(emptyList())
        private set
    var searchStatus by mutableStateOf("")
        private set
    var moreResults by mutableStateOf(false)
        private set
    /** The results are over the list; picking one puts them away, until the field is used again. */
    var resultsShown by mutableStateOf(true)
        private set

    fun showResults() {
        resultsShown = true
    }
    private var searchJob: Job? = null
    // State, so a narrower query that finds the same messages still moves the highlight.
    private var words: List<String> by mutableStateOf(emptyList())

    fun openSearch() {
        searching = true
    }

    fun closeSearch() {
        searching = false
        searchJob?.cancel()
        query = ""
        results = emptyList()
        searchStatus = ""
        words = emptyList()
    }

    fun onQuery(q: String) {
        if (q != query) resultsShown = true
        query = q
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(300)
            runSearch(false)
        }
    }

    fun searchNow() {
        resultsShown = true
        searchJob?.cancel()
        searchJob = viewModelScope.launch { runSearch(false) }
    }

    fun searchMore() {
        searchJob?.cancel()
        searchJob = viewModelScope.launch { runSearch(true) }
    }

    private suspend fun runSearch(next: Boolean) {
        val w = if (next) words else searchWords(query)
        if (!next && w == words && results.isNotEmpty()) return
        if (w.isEmpty()) {
            words = emptyList()
            results = emptyList()
            searchStatus = ""
            moreResults = false
            return
        }
        if (!next) words = w
        searchStatus = "Searching…"
        val before = if (next) results.lastOrNull()?.let { Cursor(it.created, it.id) } else null
        val page = runCatching { services.api.page(searchQuery(roomId, w, before)) }.getOrNull()
        if (page == null) {
            searchStatus = "Couldn't search. Check your connection."
            return
        }
        results = if (next) results + page else page
        moreResults = page.size >= PAGE_SIZE
        val n = results.size
        searchStatus = if (n == 0) "No messages found." else "$n${if (moreResults) "+" else ""} ${if (n == 1) "message" else "messages"} found."
    }

    val searchWordsShown: List<String> get() = words

    /** Go to a result in the room; the results make way. */
    fun pick(m: Message) {
        resultsShown = false
        controller.goTo(m.id)
    }

    // ---- reading (§18.3)

    /** The list shows its newest messages (at the bottom, at the live edge): they are read. */
    fun onAtBottom(atBottom: Boolean) {
        controller.atBottom = atBottom
        val s = controller.state.value
        if (!atBottom) return
        controller.dismissPill()
        if (s.hasNewer || s.unsure || s.phase != chat.android.data.repo.Phase.Ready || services.store.get().away) return
        s.items.lastOrNull { it.status == null }?.let { reader?.seen(it.created) }
    }

    override fun onCleared() {
        services.opened.note(roomId)
        val s = controller.state.value
        reader?.close(caughtUp = controller.atBottom && !s.hasNewer)
        controller.close()
        services.closeRoom(roomId)
        if (editing == null) services.drafts.set(me, roomId, text.text, replyTo?.id.orEmpty())
    }

    private fun buildRows(s: RoomState): List<ListRow> {
        val out = ArrayList<ListRow>(s.items.size * 2 + 2)
        val items = s.items
        for (i in items.indices.reversed()) {
            val m = items[i]
            val prev = items.getOrNull(i - 1)
            out += ListRow.Msg(m, startsGroup(prev, m) || newDay(prev, m), m.id == s.targetId)
            if (m.id == s.unreadId) out += ListRow.NewLine
            if (newDay(prev, m)) out += ListRow.Day(Formats.day(m.created), "day-${m.id}")
        }
        if (!s.hasOlder && s.phase == chat.android.data.repo.Phase.Ready && !s.stale) out += ListRow.Beginning(beginning())
        return out
    }

    private fun newDay(prev: Message?, m: Message): Boolean = prev == null || Formats.localDay(prev.created) != Formats.localDay(m.created)

    private fun beginning(): String {
        val r = services.store.get().rooms[roomId] ?: return "Beginning of the room"
        return if (r.isDm) "Beginning of your conversation with ${r.otherMember(me)?.name ?: "Unknown"}" else "Beginning of #${r.name}"
    }

    /** The newest page of messages with attachments, for the viewer (§17.7). */
    suspend fun mediaAround(): List<Message> = runCatching { services.api.page(Pages.withFiles(Pages.latest(roomId))) }.getOrDefault(emptyList())
}
