// Records as the app sees them (DESIGN.md §5, §6), decoded from PocketBase's JSON. The same shapes as web/src/lib/types.ts.
package chat.android.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: String,
    val name: String = "",
    /** Avatar filename (§15); "" when the user has none. */
    val avatar: String = "",
    /** Doesn't take direct messages (§16.7), e.g. a Telegram bridge's stand-in. */
    @SerialName("no_dms") val noDms: Boolean = false,
)

/** Who can see a room (§23.1). */
@Serializable
enum class Visibility {
    @SerialName("private") Private,
    @SerialName("public") Public,
    @SerialName("open") Open,
}

/** Who can post in a room (§23.6). */
@Serializable
enum class Posting {
    @SerialName("everyone") Everyone,
    @SerialName("selected") Selected,
}

@Serializable
data class Room(
    val id: String,
    /** "" for a DM: its title is the other member's name. */
    val name: String = "",
    val archived: Boolean = false,
    @SerialName("created_by") val createdBy: String = "",
    /** "dm" for a direct message; anything else is a room (§16.1). */
    val kind: String = "",
    /** Absent = public (§23.1). */
    val visibility: Visibility? = null,
    /** A DM's two members, or a private room's (§23.2); empty otherwise. */
    val members: List<String> = emptyList(),
    /** Absent = everyone (§23.6). */
    val posting: Posting? = null,
    val writers: List<String> = emptyList(),
    /** DMs: when the latest message was sent ("" before the first). */
    @SerialName("last_message_at") val lastMessageAt: String = "",
    val created: String = "",
    val expand: RoomExpand? = null,
) {
    val isDm: Boolean get() = kind == "dm"
}

@Serializable
data class RoomExpand(val members: List<User> = emptyList(), val writers: List<User> = emptyList())

/** One emoji on a message and who reacted with it (§20.1), in the order they reacted. */
@Serializable
data class Reaction(val emoji: String, val users: List<String>)

/** A link's line under a message (§28): its page title and favicon (a data: URL, "" without one). */
@Serializable
data class LinkPreview(val url: String, val title: String = "", val icon: String = "")

/** What a reply shows of the message it answers (§19). */
@Serializable
data class Quoted(
    val id: String,
    val author: String = "",
    val text: String = "",
    val deleted: Boolean = false,
    val files: List<String> = emptyList(),
    val expand: QuotedExpand? = null,
)

@Serializable
data class QuotedExpand(val author: User? = null)

@Serializable
data class MessageExpand(
    val author: User? = null,
    @SerialName("reply_to") val replyTo: Quoted? = null,
    @SerialName("forwarded_from") val forwardedFrom: User? = null,
)

@Serializable
data class Message(
    val id: String,
    val room: String,
    /** "" for a service message (§5.3). */
    val author: String = "",
    val text: String = "",
    /** PocketBase datetime, e.g. "2026-10-10 12:34:56.789Z": fixed width, so string order is time order. */
    val created: String = "",
    val updated: String = "",
    /** "" when never edited. */
    @SerialName("edited_at") val editedAt: String = "",
    val deleted: Boolean = false,
    /** Stored attachment names (§17.1). */
    val files: List<String> = emptyList(),
    /** Original upload names by stored name (QA BUG-28). */
    @SerialName("file_names") val fileNames: Map<String, String> = emptyMap(),
    /** The message this one replies to (§19); "" when it isn't a reply. */
    @SerialName("reply_to") val replyTo: String = "",
    val reactions: List<Reaction> = emptyList(),
    /** Who first wrote it, when it was forwarded (§21.3). */
    @SerialName("forwarded_from") val forwardedFrom: String = "",
    /** The message a forward shows (§21.3); its files are that message's. */
    @SerialName("forward_of") val forwardOf: String = "",
    val previews: List<LinkPreview> = emptyList(),
    val expand: MessageExpand? = null,
    /** Client only: not on the server yet (§7.5). Never sent, never decoded. */
    @kotlinx.serialization.Transient val status: SendStatus? = null,
    /** Client only: attachments of a message not on the server yet, as content URIs (§17.4). */
    @kotlinx.serialization.Transient val localFiles: List<LocalFile> = emptyList(),
) {
    val isService: Boolean get() = author.isEmpty()
}

enum class SendStatus { Pending, Failed }

/** An attachment picked on the device: a content URI, its name, type and size. */
@Serializable
data class LocalFile(val uri: String, val name: String, val type: String, val size: Long)

/** The site's branding and signup policy (§24), and the oldest app it still serves (ANDROID.md §12.4). */
@Serializable
data class Site(
    val title: String = "Chat",
    /** URL of the logo, "" without one. */
    val logo: String = "",
    val inviteOnly: Boolean = false,
    val minAndroidVersion: Int = 0,
) {
    companion object {
        val DEFAULT = Site()
    }
}

/** A position in a room's history, ordered by (created, id) (§6). */
@Serializable
data class Cursor(val created: String, val id: String)

/** Unread messages per room id, as of `at` (server time, §18.2), and the recent messages they account for. */
@Serializable
data class UnreadCounts(val at: String = "", val rooms: Map<String, Int> = emptyMap(), val ids: List<String> = emptyList())

/** A hidden_rooms or room_reads row: which room it is about. */
@Serializable
data class RoomRow(val id: String, val room: String = "")
