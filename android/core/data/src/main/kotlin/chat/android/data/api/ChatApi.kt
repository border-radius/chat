// The only code that talks to PocketBase (ANDROID.md §6): web/src/api.ts. Asks for exactly the fields the app shows, so
// it never pulls anyone's email.
package chat.android.data.api

import chat.android.data.lib.PAGE_SIZE
import chat.android.data.lib.PageQuery
import chat.android.data.model.Badge
import chat.android.data.model.CollectionItem
import chat.android.data.model.CollectionMeta
import chat.android.data.model.Collections
import chat.android.data.model.Cursor
import chat.android.data.model.MediaItem
import chat.android.data.model.MediaPage
import chat.android.data.model.Message
import chat.android.data.model.Posting
import chat.android.data.model.Room
import chat.android.data.model.RoomRow
import chat.android.data.model.SaveFrom
import chat.android.data.model.Site
import chat.android.data.model.UnreadCounts
import chat.android.data.model.User
import chat.android.data.model.Visibility
import chat.android.data.pb.Body
import chat.android.data.pb.PbClient
import chat.android.data.pb.PbError
import chat.android.data.pb.PbJson
import chat.android.data.pb.Session
import chat.android.data.pb.Unsubscribe
import chat.android.data.pb.UploadFile
import chat.android.data.pb.obj
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import okhttp3.HttpUrl

/** Only what the UI renders; never user emails (§6). The web's MSG_FIELDS. */
const val MSG_FIELDS =
    "id,room,text,created,updated,edited_at,deleted,files,file_names,file_sources,reactions,previews,author,expand.author.id,expand.author.name,expand.author.avatar,expand.author.no_dms," +
        "reply_to,expand.reply_to.id,expand.reply_to.author,expand.reply_to.text,expand.reply_to.deleted,expand.reply_to.files," +
        "expand.reply_to.expand.author.id,expand.reply_to.expand.author.name," +
        "forwarded_from,forward_of,expand.forwarded_from.id,expand.forwarded_from.name"
private val MSG_OPTS = mapOf("expand" to "author,reply_to.author,forwarded_from", "fields" to MSG_FIELDS)

const val ROOM_FIELDS =
    "id,name,archived,created_by,kind,visibility,members,posting,writers,last_message_at,created," +
        "expand.members.id,expand.members.name,expand.members.avatar,expand.members.no_dms," +
        "expand.writers.id,expand.writers.name,expand.writers.avatar,expand.writers.no_dms"
private val ROOM_OPTS = mapOf("expand" to "members,writers", "fields" to ROOM_FIELDS)
private const val ROW_FIELDS = "id,room"
private const val SITE_FIELDS = "id,title,logo,invite_only,min_android_version"
private const val ACTIVITY_FIELDS = "id,room,author,deleted"
/** What the profile calls return: never the email, even your own. */
private const val USER_FIELDS = "id,name,avatar"
private const val ITEM_FIELDS = "id,collection,file,name,video,poster,created"
/** A collection's page of items, as the media grid's (DESIGN.md §30.2). */
const val COLLECTION_PAGE = 60

/** A normalized error: views never depend on PbError. */
class ApiError(message: String, val status: Int, val fields: Map<String, String> = emptyMap(), val codes: Map<String, String> = emptyMap()) :
    Exception(message)

/** The user [s] is signed in as: none for an expired session, or a superuser's. */
fun userOf(s: Session): User? {
    val r = s.record ?: return null
    if (!s.isValid() || (r["collectionName"] as? JsonPrimitive)?.content != "users") return null
    return PbJson.decodeFromJsonElement(User.serializer(), r)
}

/** `codes["auth"]` of a signUp() failure whose account *was* created but whose login then failed. */
const val SIGNUP_LOGIN_FAILED = "signup_login_failed"

/** A sentence to show for a failed request: network trouble, rate limiting, or the server's own message. */
fun errorMessage(e: Throwable): String = when {
    e !is ApiError -> "Something went wrong. Please try again."
    e.status == 0 -> "Can't reach the server. Check your connection."
    e.status == 429 -> "Too many attempts. Wait a few seconds and try again."
    else -> e.message ?: "Something went wrong. Please try again."
}

/** errorMessage, or the server's reason when it gave one (e.g. "A message was deleted." for a forward, §21). */
fun reasonOf(e: Throwable): String = (e as? ApiError)?.fields?.values?.firstOrNull() ?: errorMessage(e)

fun Throwable.toApiError(): ApiError = when (this) {
    is ApiError -> this
    is PbError -> ApiError(message ?: "", status, fields, codes)
    else -> ApiError(message ?: toString(), 0)
}

enum class Action { Create, Update, Delete }

/** A realtime record event. */
data class Change<T>(val action: Action, val record: T)

/** A message event in any room, without text or files (§18.3). */
@kotlinx.serialization.Serializable
data class Activity(val id: String, val room: String = "", val author: String = "", val deleted: Boolean = false)

/** A message to send: its client-made id, so retries can't duplicate (§17.4). */
class NewMessage(
    val id: String,
    val room: String,
    val text: String,
    val files: List<UploadFile> = emptyList(),
    val replyTo: String = "",
    /** Collection items to attach, after the files (DESIGN.md §31.2). */
    val items: List<String> = emptyList(),
)

class ChatApi(val pb: PbClient) {
    private val rejectedListeners = mutableSetOf<() -> Unit>()

    /** The one who is logged in, or null. */
    fun currentUser(): User? = userOf(pb.authStore.session.value)

    private fun me(): String = currentUser()?.id ?: throw ApiError("Not logged in.", 401)

    private suspend fun call(
        path: String,
        method: String = "GET",
        query: Map<String, Any?> = emptyMap(),
        body: Body? = null,
    ): JsonElement {
        val token = pb.authStore.token
        try {
            return pb.send(path, method, query, body)
        } catch (e: PbError) {
            // A change refused while the session went with it: often a mistake, but also what a session revoked elsewhere
            // gets, which only checking the session can tell (the web's onRejected).
            val write = method != "GET" && "/auth-" !in path
            if (e.status in REFUSED && write && token.isNotEmpty() && token == pb.authStore.token) rejectedListeners.toList().forEach { it() }
            throw e.toApiError()
        } catch (e: Exception) {
            throw e.toApiError()
        }
    }

    /** Called when the server refuses a change sent with the session (400, 401, 403, 404). */
    fun onRejected(fn: () -> Unit): () -> Unit {
        rejectedListeners += fn
        return { rejectedListeners -= fn }
    }

    private suspend inline fun <reified T> get(path: String, query: Map<String, Any?> = emptyMap()): T =
        decode(call(path, query = query))

    private inline fun <reified T> decode(json: JsonElement): T = PbJson.decodeFromJsonElement(serializer<T>(), json)

    private fun <T> items(json: JsonElement, s: KSerializer<T>): List<T> =
        PbJson.decodeFromJsonElement(ListSerializer(s), json.obj["items"] ?: JsonArray(emptyList()))

    private fun records(c: String) = "/api/collections/$c/records"
    private fun record(c: String, id: String) = "/api/collections/$c/records/${java.net.URLEncoder.encode(id, "UTF-8")}"

    private suspend fun <T> fullList(collection: String, query: Map<String, Any?>, s: KSerializer<T>, batch: Int = 1000): List<T> {
        val out = mutableListOf<T>()
        var page = 1
        while (true) {
            val list = items(call(records(collection), query = query + mapOf("page" to page, "perPage" to batch, "skipTotal" to true)), s)
            out += list
            if (list.size < batch) return out
            page++
        }
    }

    private suspend fun auth(path: String, body: JsonObject): User {
        val json = call(path, "POST", body = Body.Json(body)).obj
        val record = json["record"] as JsonObject
        pb.authStore.save(Session((json["token"] as JsonPrimitive).content, record))
        return decode(record)
    }

    /** Update a user, keeping the stored auth record in step when it is the one logged in. */
    private suspend fun updateMe(body: Body): User {
        val id = me()
        val item = call(record("users", id), "PATCH", mapOf("fields" to USER_FIELDS), body).obj
        val s = pb.authStore.session.value
        if (s.userId == id && s.record != null) pb.authStore.save(s.copy(record = JsonObject(s.record + item)))
        return decode(item)
    }

    // ---- auth (§22, §24.2)

    suspend fun signUp(email: String, password: String, name: String, inviteCode: String = ""): User {
        call(
            records("users"),
            "POST",
            body = Body.Json(buildJsonObject {
                put("email", email)
                put("password", password)
                put("passwordConfirm", password)
                put("name", name)
                if (inviteCode.isNotEmpty()) put("invite_code", inviteCode)
            }),
        )
        try {
            return logIn(email, password)
        } catch (e: ApiError) {
            throw ApiError(e.message ?: "", e.status, emptyMap(), mapOf("auth" to SIGNUP_LOGIN_FAILED))
        }
    }

    suspend fun logIn(email: String, password: String): User =
        auth("/api/collections/users/auth-with-password", buildJsonObject { put("identity", email); put("password", password) })

    /** Re-validate the stored session, which renews it. Throws when it is no longer valid. */
    suspend fun refreshAuth(): User {
        if (currentUser() == null) throw ApiError("Not logged in.", 401)
        return auth("/api/collections/users/auth-refresh", JsonObject(emptyMap()))
    }

    fun logOut() = pb.authStore.clear()

    /**
     * A stored session that ran out (the app wasn't opened before its expiry): forgotten, and the id of the user it was,
     * "" when there is none. What it left is then cleared (QA BUG-145, as the web app's `forgetExpired`).
     */
    fun forgetExpired(): String {
        val s = pb.authStore.session.value
        if (s.record == null || s.isValid()) return ""
        pb.authStore.clear()
        return s.userId
    }

    // ---- site (§24, ANDROID.md §12.4)

    /** PocketBase's health check: the server is up (ANDROID.md §17.2). */
    suspend fun health() {
        call("/api/health")
    }

    suspend fun site(): Site {
        val list = call(records("site"), query = mapOf("page" to 1, "perPage" to 1, "sort" to "created", "skipTotal" to true, "fields" to SITE_FIELDS))
        val row = (list.obj["items"] as? JsonArray)?.firstOrNull() as? JsonObject ?: return Site.DEFAULT
        val str = { k: String -> (row[k] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty() }
        val logo = str("logo")
        return Site(
            title = str("title").ifEmpty { Site.DEFAULT.title },
            logo = if (logo.isEmpty()) "" else pb.fileUrl("site", str("id"), logo).toString(),
            inviteOnly = (row["invite_only"] as? JsonPrimitive)?.content == "true",
            minAndroidVersion = (row["min_android_version"] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toInt() ?: 0,
        )
    }

    // ---- profile (§15, §22)

    suspend fun setAvatar(file: UploadFile): User = updateMe(Body.Multipart(files = mapOf("avatar" to listOf(file))))

    suspend fun removeAvatar(): User = updateMe(Body.Json(JsonObject(mapOf("avatar" to JsonNull))))

    suspend fun rename(name: String): User = updateMe(Body.Json(buildJsonObject { put("name", name) }))

    /** Change your password (§22.2): every other session is signed out, this one gets a fresh token. */
    suspend fun changePassword(oldPassword: String, password: String): User {
        me()
        return auth("/api/chat/password", buildJsonObject { put("oldPassword", oldPassword); put("password", password) })
    }

    fun avatarUrl(user: User, size: Int): String =
        if (user.avatar.isEmpty()) "" else pb.fileUrl("users", user.id, user.avatar, mapOf("thumb" to "${size}x$size")).toString()

    // ---- rooms (§5, §23)

    suspend fun listRooms(): List<Room> = fullList("rooms", mapOf("sort" to "name") + ROOM_OPTS, Room.serializer())

    suspend fun getRoom(id: String): Room = get(record("rooms", id), ROOM_OPTS)

    suspend fun createRoom(name: String, visibility: Visibility? = null): Room = decode(
        call(records("rooms"), "POST", ROOM_OPTS, Body.Json(buildJsonObject {
            put("name", name)
            put("created_by", me())
            if (visibility != null) put("visibility", visibility.wire)
        })),
    )

    suspend fun setArchived(id: String, archived: Boolean): Room =
        decode(call(record("rooms", id), "PATCH", ROOM_OPTS, Body.Json(buildJsonObject { put("archived", archived) })))

    /** Who can see the room and, with [posting], who can post (§23.2, §23.6). Only the creator may. */
    suspend fun setAccess(id: String, visibility: Visibility, members: List<String>, posting: Posting? = null, writers: List<String> = emptyList()): Room =
        decode(
            call(record("rooms", id), "PATCH", ROOM_OPTS, Body.Json(buildJsonObject {
                put("visibility", visibility.wire)
                put("members", JsonArray((if (visibility == Visibility.Private) members else emptyList()).map { JsonPrimitive(it) }))
                if (posting != null) {
                    put("posting", posting.wire)
                    put("writers", JsonArray((if (posting == Posting.Selected) writers else emptyList()).map { JsonPrimitive(it) }))
                }
            })),
        )

    // ---- direct messages (§16)

    /** The DM with [userId], created on first use; reopened if you had closed it. */
    suspend fun openDm(userId: String): Room = decode(call("/api/chat/dms", "POST", body = Body.Json(buildJsonObject { put("user", userId) })))

    /** Up to 20 other users whose name contains [query] (ignoring case beyond ASCII, QA BUG-55). */
    suspend fun searchUsers(query: String): List<User> {
        me()
        return decode(call("/api/chat/users", query = mapOf("q" to query)))
    }

    /** The users with these ids (at most 50). Unknown ids are left out. */
    suspend fun usersById(ids: List<String>): List<User> {
        val some = ids.take(50)
        if (some.isEmpty()) return emptyList()
        val filter = pb.filter(some.indices.joinToString(" || ") { "id = {:u$it}" }, some.withIndex().associate { "u${it.index}" to it.value })
        return items(call(records("users"), query = mapOf("page" to 1, "perPage" to some.size, "filter" to filter, "fields" to USER_FIELDS, "skipTotal" to true)), User.serializer())
    }

    // ---- hidden rooms (§13)

    suspend fun listHidden(): List<RoomRow> = fullList("hidden_rooms", mapOf("fields" to ROW_FIELDS), RoomRow.serializer())

    suspend fun hideRoom(room: String): RoomRow = decode(
        call(records("hidden_rooms"), "POST", mapOf("fields" to ROW_FIELDS), Body.Json(buildJsonObject { put("user", me()); put("room", room) })),
    )

    suspend fun unhideRoom(rowId: String) {
        call(record("hidden_rooms", rowId), "DELETE")
    }

    // ---- unread (§18)

    suspend fun unreadCounts(): UnreadCounts = get("/api/chat/unread")

    /** The oldest unread message in a room; its id is "" when there is none. */
    suspend fun firstUnread(room: String): Cursor = get("/api/chat/unread/${java.net.URLEncoder.encode(room, "UTF-8")}")

    /** You have read [room] up to [at] (a message's `created`). The server never moves it back. */
    suspend fun markRead(room: String, at: String) {
        call("/api/chat/reads", "POST", body = Body.Json(buildJsonObject { put("room", room); put("at", at) }))
    }

    // ---- messages (§6, §7)

    private fun listQuery(q: PageQuery) = mapOf("filter" to pb.filter(q.filter, q.params), "sort" to q.sort, "skipTotal" to true) + MSG_OPTS

    suspend fun page(q: PageQuery, size: Int = PAGE_SIZE): List<Message> =
        items(call(records("messages"), query = listQuery(q) + mapOf("page" to 1, "perPage" to size)), Message.serializer())

    suspend fun getMessage(id: String): Message = get(record("messages", id), MSG_OPTS)

    /** Every message matching [q], not just one page: the edits and deletes missed during a disconnect. */
    suspend fun changes(q: PageQuery): List<Message> = fullList("messages", listQuery(q), Message.serializer(), 200)

    suspend fun send(m: NewMessage, onUpload: ((Float) -> Unit)? = null): Message {
        val fields = buildMap {
            put("id", m.id)
            put("room", m.room)
            put("author", me())
            put("text", m.text)
            if (m.replyTo.isNotEmpty()) put("reply_to", m.replyTo)
        }
        val items = JsonArray(m.items.map { JsonPrimitive(it) })
        val body = if (m.files.isEmpty()) {
            Body.Json(JsonObject(fields.mapValues { JsonPrimitive(it.value) } + if (m.items.isEmpty()) emptyMap() else mapOf("items" to items)))
        } else {
            // In a form, the items are a JSON list (§31.2).
            Body.Multipart(if (m.items.isEmpty()) fields else fields + ("items" to items.toString()), mapOf("files" to m.files), onUpload = onUpload)
        }
        return decode(call(records("messages"), "POST", MSG_OPTS, body))
    }

    suspend fun edit(id: String, text: String): Message = decode(call(record("messages", id), "PATCH", MSG_OPTS, Body.Json(buildJsonObject { put("text", text) })))

    suspend fun softDelete(id: String): Message = decode(call(record("messages", id), "PATCH", MSG_OPTS, Body.Json(buildJsonObject { put("deleted", true) })))

    /** Add ([on]) or remove your [emoji] reaction (§20). Idempotent. */
    suspend fun react(id: String, emoji: String, on: Boolean): Message = decode(
        call("/api/chat/reactions", "POST", MSG_OPTS, Body.Json(buildJsonObject { put("message", id); put("emoji", emoji); put("on", on) })),
    )

    /** Soft-delete several of your messages at once, all or none (§21.2). */
    suspend fun deleteMany(ids: List<String>): List<Message> =
        decode(call("/api/chat/delete", "POST", MSG_OPTS, Body.Json(JsonObject(mapOf("messages" to JsonArray(ids.map { JsonPrimitive(it) }))))))

    /** Copy messages into [room] as yours, saying who first wrote them, all or none (§21.3). */
    suspend fun forward(ids: List<String>, room: String): List<Message> = decode(
        call("/api/chat/forward", "POST", MSG_OPTS, Body.Json(JsonObject(mapOf("messages" to JsonArray(ids.map { JsonPrimitive(it) }), "room" to JsonPrimitive(room))))),
    )

    // ---- files (§17.3)

    /** A new file token for protected attachments; "" for a guest, who reads Open Air rooms without one (§23.3). */
    suspend fun newFileToken(): String {
        if (currentUser() == null) return ""
        return (call("/api/files/token", "POST").obj["token"] as? JsonPrimitive)?.content.orEmpty()
    }

    /** An attachment's URL without a token: a forward's attachments are its original's (§21.3). */
    fun fileUrl(m: Message, filename: String, thumb: String? = null, token: String? = null): HttpUrl =
        pb.fileUrl("messages", m.forwardOf.ifEmpty { m.id }, filename, mapOf("thumb" to thumb, "token" to token?.ifEmpty { null }))

    /**
     * A page of the room's images and videos (DESIGN.md §30: the media grid), newest first, older than [after] (or
     * the newest). 404 for a room you can't see.
     */
    suspend fun media(room: String, after: MediaItem? = null, limit: Int = 60): MediaPage =
        get("/api/chat/media/$room", buildMap {
            put("limit", limit)
            if (after != null) {
                put("sent", after.sent)
                put("message", after.message)
                put("pos", after.pos)
            }
        })

    /** A media grid tile's file (of the message that holds it, [MediaItem.source]), as a square thumbnail. */
    fun mediaUrl(item: MediaItem, thumb: String? = "240x240", token: String? = null): HttpUrl =
        pb.fileUrl("messages", item.source.ifEmpty { item.message }, item.file, mapOf("thumb" to thumb, "token" to token?.ifEmpty { null }))

    /** A media grid tile's video poster. */
    fun mediaPosterUrl(item: MediaItem, token: String? = null): HttpUrl =
        pb.url("/api/chat/posters/${item.source.ifEmpty { item.message }}/${item.file}", mapOf("token" to token?.ifEmpty { null }))

    /** A video's poster frame (DESIGN.md §30: made by the server's media worker; 404 until then, or without ffmpeg). */
    fun posterUrl(m: Message, filename: String, token: String? = null): HttpUrl =
        pb.url("/api/chat/posters/${m.forwardOf.ifEmpty { m.id }}/$filename", mapOf("token" to token?.ifEmpty { null }))

    // ---- collections (DESIGN.md §31)

    /** Yours and the public ones you follow, by name; those followed with how many of their items are new. */
    suspend fun collections(): Collections = get("/api/chat/collections")

    /** You have seen a collection you follow up to [at] (its newest item's `created`), or up to now. Forward only. */
    suspend fun markSeen(collection: String, at: String = "") {
        call("/api/chat/subs/seen", "POST", body = Body.Json(buildJsonObject { put("collection", collection); if (at.isNotEmpty()) put("at", at) }))
    }

    /** What the badges of files attached from these collections may say; null for one that is gone. At most 50. */
    suspend fun badges(ids: List<String>): Map<String, Badge?> = get("/api/chat/badges", mapOf("ids" to ids.joinToString(",")))

    /** A collection with its owner's name. 404 for one you can't see (or that is gone). */
    suspend fun collection(id: String): CollectionMeta =
        get(record("collections", id), mapOf("expand" to "owner", "fields" to "id,name,public,owner,items,expand.owner.id,expand.owner.name"))

    /** A new collection of yours; its id. */
    suspend fun createCollection(name: String, public: Boolean): String = (call(
        records("collections"),
        "POST",
        mapOf("fields" to "id"),
        Body.Json(buildJsonObject { put("owner", me()); put("name", name); put("public", public) }),
    ).obj["id"] as JsonPrimitive).content

    /** Rename yours, or make it public or private. */
    suspend fun updateCollection(id: String, name: String? = null, public: Boolean? = null): CollectionMeta = decode(
        call(record("collections", id), "PATCH", mapOf("fields" to "id,name,public,owner,items"), Body.Json(buildJsonObject {
            if (name != null) put("name", name)
            if (public != null) put("public", public)
        })),
    )

    suspend fun deleteCollection(id: String) {
        call(record("collections", id), "DELETE")
    }

    /**
     * A page of a collection's items, newest first: older than [after] (the oldest shown), or the newest; with [newer],
     * those added after [after] (the newest shown), the oldest of them first. [more]: there are more than a page.
     */
    suspend fun collectionItems(collection: String, after: CollectionItem? = null, newer: Boolean = false, size: Int = COLLECTION_PAGE): Pair<List<CollectionItem>, Boolean> {
        val op = if (newer) ">" else "<"
        val cursor = if (after == null) "" else " && (created $op {:c} || (created = {:c} && id $op {:i}))"
        val filter = pb.filter("collection = {:coll}$cursor", mapOf("coll" to collection, "c" to after?.created, "i" to after?.id))
        val list = items(
            call(records("collection_items"), query = mapOf(
                "filter" to filter,
                "sort" to if (newer) "created,id" else "-created,-id",
                "page" to 1,
                "perPage" to size + 1,
                "skipTotal" to true,
                "fields" to ITEM_FIELDS,
            )),
            CollectionItem.serializer(),
        )
        return list.take(size) to (list.size > size)
    }

    /** The ids of a collection's items from [oldest] on (it included): which of those shown are still there. */
    suspend fun itemIdsSince(collection: String, oldest: CollectionItem): Set<String> {
        val filter = pb.filter("collection = {:coll} && (created > {:c} || (created = {:c} && id >= {:i}))", mapOf("coll" to collection, "c" to oldest.created, "i" to oldest.id))
        return fullList("collection_items", mapOf("filter" to filter, "sort" to "-created,-id", "fields" to "id"), chat.android.data.model.RoomRow.serializer()).map { it.id }.toSet()
    }

    /** A copy of a message's file, or of an item, in a collection of yours. 409: it is in there already. */
    suspend fun saveItem(collection: String, from: SaveFrom): CollectionItem = decode(
        call("/api/chat/items", "POST", body = Body.Json(buildJsonObject {
            put("collection", collection)
            when (from) {
                is SaveFrom.File -> { put("message", from.message); put("file", from.file) }
                is SaveFrom.Item -> put("item", from.item)
            }
        })),
    )

    /** An image or video of your own, uploaded straight into a collection of yours (20 MB at most). */
    suspend fun uploadItem(collection: String, file: UploadFile, onUpload: ((Float) -> Unit)? = null): CollectionItem = decode(
        call("/api/chat/items", "POST", body = Body.Multipart(mapOf("collection" to collection), mapOf("file" to listOf(file)), onUpload = onUpload)),
    )

    /** Take an item out of a collection of yours. */
    suspend fun removeItem(item: String) {
        call("/api/chat/items/$item", "DELETE")
    }

    /** Your collections that have the file already: collection id → item id. */
    suspend fun savedIn(from: SaveFrom): Map<String, String> = get(
        "/api/chat/saved",
        when (from) {
            is SaveFrom.File -> mapOf("message" to from.message, "file" to from.file)
            is SaveFrom.Item -> mapOf("item" to from.item)
        },
    )

    /** Follow someone else's public collection ([on]), or stop. */
    suspend fun follow(collection: String, on: Boolean) {
        call("/api/chat/subs", "POST", body = Body.Json(buildJsonObject { put("collection", collection); put("on", on) }))
    }

    /** An item's file, or its square grid thumbnail. */
    fun itemUrl(id: String, file: String, thumb: String? = null, token: String? = null): HttpUrl =
        pb.fileUrl("collection_items", id, file, mapOf("thumb" to thumb, "token" to token?.ifEmpty { null }))

    /** A video item's poster frame. */
    fun itemPosterUrl(id: String, file: String, token: String? = null): HttpUrl =
        pb.url("/api/chat/posters/items/$id/$file", mapOf("token" to token?.ifEmpty { null }))

    /**
     * Changes of your collections, of those you follow ([ids]: one topic each, as a filter naming them all could be
     * longer than a topic may be) and of your own subscriptions.
     */
    suspend fun subscribeCollections(ids: List<String>, fn: () -> Unit): Unsubscribe {
        val offs = mutableListOf<Unsubscribe>()
        try {
            offs += pb.realtime.subscribe("collections/*", mapOf("fields" to "id", "filter" to pb.filter("owner = {:me}", mapOf("me" to me())))) { fn() }
            offs += pb.realtime.subscribe("collection_subs/*", mapOf("fields" to "id")) { fn() }
            for (id in ids) offs += pb.realtime.subscribe("collections/$id", mapOf("fields" to "id")) { fn() }
        } catch (e: Exception) {
            for (off in offs) runCatching { off() }
            throw e.toApiError()
        }
        return { for (off in offs) runCatching { off() } }
    }

    /** The id of any collection whose badge may say something else now: made public or private, renamed, deleted. */
    suspend fun subscribeBadges(fn: (String) -> Unit): Unsubscribe =
        try {
            pb.realtime.subscribe("chat/badges") { d -> (d["id"] as? JsonPrimitive)?.content?.let(fn) }
        } catch (e: Exception) {
            throw e.toApiError()
        }

    // ---- push (ANDROID.md §8)

    /** Register this device for pushes; returns the row id (to delete on log out). */
    suspend fun registerPush(token: String, provider: String): String = (call(
        records("push_tokens"),
        "POST",
        mapOf("fields" to "id"),
        Body.Json(buildJsonObject { put("user", me()); put("token", token); put("provider", provider) }),
    ).obj["id"] as JsonPrimitive).content

    suspend fun unregisterPush(rowId: String) {
        call(record("push_tokens", rowId), "DELETE")
    }

    // ---- realtime

    private suspend fun <T> subscribe(collection: String, query: Map<String, String>, s: KSerializer<T>, fn: (Change<T>) -> Unit): Unsubscribe =
        try {
            pb.realtime.subscribe("$collection/*", query) { e ->
                val action = when ((e["action"] as? JsonPrimitive)?.content) {
                    "create" -> Action.Create
                    "update" -> Action.Update
                    "delete" -> Action.Delete
                    else -> return@subscribe
                }
                val record = runCatching { PbJson.decodeFromJsonElement(s, e["record"] ?: return@subscribe) }.getOrNull() ?: return@subscribe
                fn(Change(action, record))
            }
        } catch (e: Exception) {
            throw e.toApiError()
        }

    suspend fun subscribeMessages(room: String, fn: (Change<Message>) -> Unit) =
        subscribe("messages", MSG_OPTS + ("filter" to pb.filter("room = {:room}", mapOf("room" to room))), Message.serializer(), fn)

    suspend fun subscribeRooms(fn: (Change<Room>) -> Unit) = subscribe("rooms", ROOM_OPTS, Room.serializer(), fn)

    suspend fun subscribeHidden(fn: (Change<RoomRow>) -> Unit) = subscribe("hidden_rooms", mapOf("fields" to ROW_FIELDS), RoomRow.serializer(), fn)

    /** Every message event in every room you can see, without text or files (§18.3). */
    suspend fun subscribeAllMessages(fn: (Change<Activity>) -> Unit) = subscribe("messages", mapOf("fields" to ACTIVITY_FIELDS), Activity.serializer(), fn)

    /** Your own room_reads rows, e.g. written on another device. */
    suspend fun subscribeReads(fn: (Change<RoomRow>) -> Unit) = subscribe("room_reads", mapOf("fields" to ROW_FIELDS), RoomRow.serializer(), fn)

    /** Every realtime (re)connect: true when events may have been missed. */
    val connects: SharedFlow<Boolean> get() = pb.realtime.connects

    private companion object {
        val REFUSED = setOf(400, 401, 403, 404)
    }
}

val Visibility.wire: String
    get() = when (this) {
        Visibility.Private -> "private"
        Visibility.Public -> "public"
        Visibility.Open -> "open"
    }

val Posting.wire: String
    get() = when (this) {
        Posting.Everyone -> "everyone"
        Posting.Selected -> "selected"
    }
