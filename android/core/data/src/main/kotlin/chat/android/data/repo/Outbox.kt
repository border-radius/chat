// Messages on their way to the server (ANDROID.md §9.2): written as pending with the id they will keep there, then
// posted one after another, in the order they were written, in-process at once and by WorkManager after a process
// death. A retry reuses the id, so the server never makes a duplicate (DESIGN.md §17.4). Offline, a message waits;
// only a refusal by the server makes it "Couldn't send · Retry".
package chat.android.data.repo

import chat.android.data.api.ApiError
import chat.android.data.api.ChatApi
import chat.android.data.api.NewMessage
import chat.android.data.db.ChatDatabase
import chat.android.data.db.OutboxEntity
import chat.android.data.model.Message
import chat.android.data.model.SendStatus
import chat.android.data.pb.PbJson
import chat.android.data.pb.UploadFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

/** How a drain ended: everything sent (or refused), or stopped by network trouble (try again later). */
enum class DrainResult { Done, Retry }

/** What the outbox keeps of an optimistic message: the message, and its files (paths in app storage). */
@Serializable
private data class Outgoing(val message: Message, val files: List<chat.android.data.model.LocalFile> = emptyList(), val serverErrors: Int = 0)

class Outbox(
    private val api: ChatApi,
    private val db: ChatDatabase,
    private val scope: CoroutineScope,
    /** Ask WorkManager to drain the outbox (with a network), in case the process dies before it is done. */
    private val schedule: () -> Unit,
) {
    private val lock = Mutex()
    private val savedFlow = MutableSharedFlow<Message>(extraBufferCapacity = 64)
    private val progressFlow = MutableStateFlow<Map<String, Float>>(emptyMap())

    /** Every message in the outbox, as it should show: pending or failed, with its local files. */
    val messages: StateFlow<List<Message>> = db.outbox().observe()
        .map { rows -> rows.mapNotNull { it.toMessage() } }
        .stateIn(scope, SharingStarted.Eagerly, emptyList())

    /** Messages the server has taken, as it answered. */
    val saved: SharedFlow<Message> = savedFlow.asSharedFlow()

    /** Upload progress of messages with files, 0 to 1 (§17.4). */
    val progress: StateFlow<Map<String, Float>> = progressFlow.asStateFlow()

    private fun OutboxEntity.toMessage(): Message? = runCatching {
        val o = PbJson.decodeFromString(Outgoing.serializer(), json)
        o.message.copy(status = if (state == 0) SendStatus.Pending else SendStatus.Failed, localFiles = o.files)
    }.getOrNull()

    /** Queue [m] (pending, with its client id and local files) and start sending. */
    suspend fun enqueue(user: String, m: Message) {
        db.outbox().put(OutboxEntity(m.id, m.room, user, PbJson.encodeToString(Outgoing.serializer(), Outgoing(m, m.localFiles)), 0, System.currentTimeMillis()))
        kick()
    }

    /** Send a failed message again, with the same id. */
    suspend fun retry(id: String) {
        db.outbox().setState(id, 0)
        kick()
    }

    /** Drop a failed message and its files (no request). */
    suspend fun discard(id: String) {
        db.outbox().get(id)?.toMessage()?.let { deleteFiles(it) }
        db.outbox().delete(id)
    }

    private fun kick() {
        schedule()
        scope.launch { drain() }
    }

    /** Post every pending message, oldest first. One drain at a time. */
    suspend fun drain(): DrainResult = lock.withLock {
        while (true) {
            val row = db.outbox().next() ?: return DrainResult.Done
            val o = runCatching { PbJson.decodeFromString(Outgoing.serializer(), row.json) }.getOrNull()
            if (o == null || api.currentUser()?.id != row.user) {
                db.outbox().delete(row.id) // not this session's (the session ended): never sent as someone else
                continue
            }
            when (val r = deliver(o)) {
                is Delivered.Saved -> {
                    db.outbox().delete(row.id)
                    deleteFiles(o.message.copy(localFiles = o.files))
                    savedFlow.emit(r.message)
                }
                is Delivered.Refused -> db.outbox().put(row.copy(state = 1, json = PbJson.encodeToString(Outgoing.serializer(), o.copy(message = r.message))))
                Delivered.Offline -> return DrainResult.Retry
                Delivered.ServerError -> {
                    if (o.serverErrors + 1 >= MAX_SERVER_ERRORS) db.outbox().setState(row.id, 1)
                    else {
                        db.outbox().put(row.copy(json = PbJson.encodeToString(Outgoing.serializer(), o.copy(serverErrors = o.serverErrors + 1))))
                        return DrainResult.Retry
                    }
                }
            }
            progressFlow.value -= row.id
        }
        @Suppress("UNREACHABLE_CODE")
        DrainResult.Done
    }

    private sealed interface Delivered {
        data class Saved(val message: Message) : Delivered
        data class Refused(val message: Message) : Delivered
        data object Offline : Delivered
        data object ServerError : Delivered
    }

    private suspend fun deliver(o: Outgoing): Delivered {
        val msg = o.message
        val files = o.files.map { f -> UploadFile(f.name, f.type, File(f.uri).asRequestBody(f.type.toMediaTypeOrNull())) }
        return try {
            val saved = api.send(NewMessage(msg.id, msg.room, msg.text, files, msg.replyTo)) { fraction ->
                progressFlow.value += msg.id to fraction
            }
            Delivered.Saved(saved)
        } catch (e: ApiError) {
            when {
                e.status >= 500 -> Delivered.ServerError
                else -> {
                    // A retry of a send that reached the server fails with a duplicate id: it was sent after all.
                    val recovered = if (e.status == 400) runCatching { api.getMessage(msg.id) }.getOrNull() else null
                    if (recovered != null && recovered.author == api.currentUser()?.id) return Delivered.Saved(recovered)
                    // A reply whose original was deleted meanwhile can only go without its quote (§19): Retry sends it so.
                    val quoted = msg.expand?.replyTo
                    if ("reply_to" in e.fields && quoted != null) {
                        Delivered.Refused(msg.copy(replyTo = "", expand = msg.expand.copy(replyTo = quoted.copy(text = "", deleted = true))))
                    } else Delivered.Refused(msg)
                }
            }
        }
    }

    private fun deleteFiles(m: Message) {
        for (f in m.localFiles) runCatching { File(f.uri).delete() }
        // The folder the files were copied into, once empty.
        m.localFiles.firstOrNull()?.let { runCatching { File(it.uri).parentFile?.takeIf { d -> d.list()?.isEmpty() == true }?.delete() } }
    }

    /** The session ended: nothing of it may be sent. */
    suspend fun clear() {
        lock.withLock {
            for (m in messages.value) deleteFiles(m)
            db.outbox().clear()
        }
    }

    private companion object {
        const val MAX_SERVER_ERRORS = 3
    }
}
