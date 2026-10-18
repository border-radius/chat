// PocketBase realtime (ANDROID.md §6.1, §9.1): one SSE stream whose PB_CONNECT event carries the client id; the set of
// subscriptions (topic plus its options) is POSTed to /api/realtime whenever it changes, and again after a reconnect.
// The protocol of web/src/pb.ts. All state lives on one thread ([rt]), as it does in the browser.
package chat.android.data.pb

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

/** Stop listening; suspends until the server has the smaller set of subscriptions. */
typealias Unsubscribe = suspend () -> Unit

class Realtime internal constructor(private val pb: PbClient) {
    @OptIn(ExperimentalCoroutinesApi::class)
    private val rt = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + rt)
    /** Its own dispatcher: the stream is a call that never ends, and must not take one of the API's per-host slots. */
    private val factory = EventSources.createFactory(
        pb.http.newBuilder().dispatcher(okhttp3.Dispatcher()).readTimeout(0, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build(),
    )

    private var es: EventSource? = null
    private var clientId = ""
    /** Subscription key → listeners. A key is the topic plus its options, and the event name the server uses. */
    private val subs = LinkedHashMap<String, MutableList<(JsonObject) -> Unit>>()
    private var lastSent: List<String> = emptyList()
    private var attempts = 0
    private var lost = false
    private var everConnected = false
    private var connectTimer: Job? = null
    private var reconnectTimer: Job? = null
    private val pending = mutableListOf<CompletableDeferred<Unit>>()
    /** The in-flight subscriptions POST, cancelled on disconnect. */
    private var submitting: Job? = null
    /** Submits run one after another, so an older subscription set never lands after a newer one. */
    private val submits = Mutex()
    /** In the background (§9.1): no connection, but the subscriptions are kept for the next one. */
    private var paused = false

    private val connectsFlow = MutableSharedFlow<Boolean>(extraBufferCapacity = 16)

    /** Every (re)connect, once its subscriptions are in: `true` when events may have been missed before it. */
    val connects: SharedFlow<Boolean> = connectsFlow.asSharedFlow()

    /** Connected, with a client id, and no connect in progress. */
    val isConnected: Boolean get() = es != null && clientId.isNotEmpty() && pending.isEmpty()

    init {
        // The server knows who a client is from the token its subscriptions were sent with. A new token for the same
        // user must reach it (QA BUG-52); someone else, or nobody, needs a new connection (QA BUG-66).
        scope.launch {
            var token = pb.authStore.token
            var who = if (token.isNotEmpty()) pb.authStore.session.value.userId else ""
            pb.authStore.session.collect { s ->
                if (s.token == token) return@collect
                token = s.token
                val next = if (token.isNotEmpty()) s.userId else ""
                if (next == who) resubmit() else {
                    who = next
                    restart()
                }
            }
        }
    }

    /**
     * Listen to [topic] (a collection name and a star: every record of it), with [query] (fields, expand, filter) applied to its events. Returns once
     * the server has the subscription, so an event caused after that reaches [listener], which runs on the realtime
     * thread and must not block. Offline, it returns at once: the subscription is kept, and sent once a connection is
     * made (which [connects] then reports as a reconnect, since events may have been missed).
     */
    suspend fun subscribe(topic: String, query: Map<String, String>? = null, listener: (JsonObject) -> Unit): Unsubscribe =
        withContext(rt) {
            val key = if (query == null) topic else "$topic?options=${encodeUriComponent(JsonObject(mapOf("query" to JsonObject(query.mapValues { JsonPrimitive(it.value) }))).toString())}"
            val list = subs.getOrPut(key) { mutableListOf() }
            val first = list.isEmpty()
            list += listener
            if (!paused) {
                try {
                    if (es == null || clientId.isEmpty() || pending.isNotEmpty()) connect() else if (first) submit()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Offline or refused: the reconnects go on, and send it (QA BUG-85).
                }
            }
            val off: Unsubscribe = {
                withContext(rt + NonCancellable) {
                    val left = subs[key]
                    left?.remove(listener)
                    if (left != null && left.isEmpty()) subs.remove(key)
                    runCatching { submit() }
                }
            }
            off
        }

    /** [subscribe] as a Flow of events: subscribed while collected. */
    fun events(topic: String, query: Map<String, String>? = null): Flow<JsonObject> = callbackFlow {
        val off = subscribe(topic, query) { trySend(it) }
        awaitClose { scope.launch { off() } }
    }

    /** Close the connection while the app is in the background; [resume] opens it again (§9.1). */
    fun pause() {
        scope.launch {
            if (paused) return@launch
            paused = true
            disconnect()
        }
    }

    /** Back in the foreground: connect again, as after a lost connection (events may have been missed). */
    fun resume() {
        scope.launch {
            if (!paused) return@launch
            paused = false
            if (subs.isNotEmpty()) {
                lost = true
                attempts = 0
                initConnect()
            }
        }
    }

    /** Drop every subscription and close the connection. */
    suspend fun unsubscribeAll() = withContext(rt) {
        subs.clear()
        disconnect()
    }

    private fun keys() = subs.keys.toList()

    private fun unsent(): Boolean {
        val now = keys()
        return now.size != lastSent.size || now.any { it !in lastSent }
    }

    private suspend fun sendSubs() {
        if (clientId.isEmpty()) return
        if (subs.isEmpty()) return disconnect()
        if (!unsent()) return
        lastSent = keys()
        val body = JsonObject(mapOf("clientId" to JsonPrimitive(clientId), "subscriptions" to JsonArray(lastSent.map { JsonPrimitive(it) })))
        val call = scope.async { pb.send("/api/realtime", "POST", body = Body.Json(body)) }
        submitting = call
        try {
            call.await()
        } catch (e: CancellationException) {
            currentCoroutineContext().ensureActive() // only the POST was cancelled (a disconnect): not an error
        }
    }

    private suspend fun submit() = withContext(rt) { submits.withLock { sendSubs() } }

    private suspend fun connect() {
        if (attempts > 0) return // a reconnect is scheduled; it sends every subscription
        val d = CompletableDeferred<Unit>()
        pending += d
        if (pending.size == 1) scope.launch { initConnect() }
        d.await()
    }

    private fun initConnect() {
        disconnect(reconnecting = true)
        if (paused) return
        connectTimer = scope.launch {
            delay(CONNECT_TIMEOUT_MS)
            connectError(PbError(0))
        }
        val request = Request.Builder().url(pb.url("/api/realtime")).header("Accept", "text/event-stream").build()
        lateinit var source: EventSource
        source = factory.newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                scope.launch {
                    if (es !== source) return@launch
                    if (type == "PB_CONNECT") onConnected(source, id.orEmpty()) else dispatch(type.orEmpty(), data)
                }
            }

            override fun onClosed(eventSource: EventSource) {
                scope.launch { if (es === source) connectError(PbError(0)) }
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                response?.close()
                scope.launch { if (es === source) connectError(PbError(response?.code ?: 0, cause = t)) }
            }
        })
        es = source
    }

    private fun onConnected(source: EventSource, id: String) {
        clientId = id
        lastSent = emptyList()
        // A connection replaced meanwhile must leave the current one alone.
        val current = { es === source }
        scope.launch {
            try {
                submit()
                var tries = 3
                while (current() && unsent() && tries-- > 0) submit()
                if (!current()) return@launch
                pending.forEach { it.complete(Unit) }
                pending.clear()
                attempts = 0
                reconnectTimer?.cancel()
                connectTimer?.cancel()
                val reconnect = everConnected || lost
                everConnected = true
                lost = false
                connectsFlow.emit(reconnect)
                if (unsent()) submit()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!current()) return@launch
                clientId = ""
                lastSent = emptyList()
                connectError(e)
            }
        }
    }

    private fun dispatch(key: String, data: String) {
        val event = runCatching { PbJson.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        subs[key]?.toList()?.forEach { it(event) }
    }

    private fun connectError(err: Exception) {
        connectTimer?.cancel()
        reconnectTimer?.cancel()
        lost = true
        if (clientId.isEmpty() && attempts == 0) {
            // The first connect failed: tell those waiting, then go on trying like after a lost connection (QA BUG-85).
            pending.forEach { it.completeExceptionally(err as? PbError ?: PbError(0, cause = err)) }
            pending.clear()
            if (subs.isEmpty()) return disconnect()
        }
        disconnect(reconnecting = true)
        if (paused) return
        val wait = RECONNECT_MS[minOf(attempts, RECONNECT_MS.lastIndex)]
        reconnectTimer = scope.launch {
            delay(wait)
            initConnect()
        }
        attempts++
    }

    private fun disconnect(reconnecting: Boolean = false) {
        connectTimer?.cancel()
        reconnectTimer?.cancel()
        submitting?.cancel()
        submitting = null
        es?.cancel()
        es = null
        clientId = ""
        lastSent = emptyList()
        if (!reconnecting) {
            attempts = 0
            pending.forEach { it.complete(Unit) }
            pending.clear()
        }
    }

    /** Send the subscriptions again (with the current token), if connected. */
    private fun resubmit() {
        if (clientId.isEmpty() || subs.isEmpty()) return
        lastSent = emptyList()
        val source = es
        scope.launch {
            try {
                submit()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (es === source) connectError(e) // not a failure of a connection that replaced this one (QA BUG-68)
            }
        }
    }

    /** Close the connection and, with subscriptions left, open a new one that sends them all. */
    private fun restart() {
        if (es == null && pending.isEmpty()) return
        disconnect()
        if (subs.isNotEmpty() && !paused) scope.launch { runCatching { connect() } }
    }

    private companion object {
        /** Wait before reconnect attempt n; the last value repeats. The web's steps, then slower: a phone may be offline for hours. */
        val RECONNECT_MS = longArrayOf(200, 300, 500, 1000, 1200, 1500, 2000, 5000, 10_000, 30_000)
        const val CONNECT_TIMEOUT_MS = 15_000L
    }
}

/** JavaScript's encodeURIComponent: the subscription key must be the one the web app would send. */
internal fun encodeUriComponent(s: String): String {
    val out = StringBuilder()
    for (b in s.toByteArray(Charsets.UTF_8)) {
        val c = b.toInt() and 0xff
        if (c in 'a'.code..'z'.code || c in 'A'.code..'Z'.code || c in '0'.code..'9'.code || c.toChar() in "-_.!~*'()") out.append(c.toChar())
        else out.append('%').append("0123456789ABCDEF"[c shr 4]).append("0123456789ABCDEF"[c and 15])
    }
    return out.toString()
}
