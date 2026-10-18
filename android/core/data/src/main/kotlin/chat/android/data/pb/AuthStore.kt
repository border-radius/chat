package chat.android.data.pb

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.util.Base64

/** A session: the token and the auth record PocketBase answered with. */
@Serializable
data class Session(val token: String = "", val record: JsonObject? = null) {
    /** The record's id, "" without one. */
    val userId: String get() = record?.str("id").orEmpty()

    /** When the token expires (epoch ms), 0 without a readable token. */
    val expiresAt: Long get() = tokenExp(token) * 1000

    fun isValid(now: Long = System.currentTimeMillis()): Boolean = token.isNotEmpty() && expiresAt > now

    companion object {
        val NONE = Session()
    }
}

/** The JWT's `exp` (seconds), or 0 when it can't be read. */
internal fun tokenExp(token: String): Long = runCatching {
    val part = token.split('.')[1]
    val json = String(Base64.getUrlDecoder().decode(part.trimEnd('=')))
    (PbJson.parseToJsonElement(json) as JsonObject).str("exp")!!.toDouble().toLong()
}.getOrDefault(0)

/** Where the session lives. [session] changes on every save and clear. */
interface AuthStore {
    val session: StateFlow<Session>
    val token: String get() = session.value.token

    fun save(session: Session)

    fun clear() = save(Session.NONE)
}

/** In memory only: tests, and the moments before the stored session is read. */
open class MemoryAuthStore(initial: Session = Session.NONE) : AuthStore {
    private val state = MutableStateFlow(initial)
    override val session: StateFlow<Session> = state.asStateFlow()

    override fun save(session: Session) {
        state.value = session
    }
}
