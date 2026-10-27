// Room commands shared by the room list and the room screen (web/src/actions.ts): call the server, then update the
// store. They throw ApiError; showing the failure is up to the caller.
package chirkle.android.data.repo

import chirkle.android.data.api.ChirkleApi
import chirkle.android.data.model.Posting
import chirkle.android.data.model.Room
import chirkle.android.data.model.Visibility

class RoomActions(private val api: ChirkleApi, private val store: Store) {
    suspend fun create(name: String, visibility: Visibility = Visibility.Public): Room =
        api.createRoom(name, visibility).also { r -> store.update { it.upsertRoom(r) } }

    suspend fun hide(roomId: String) {
        val row = api.hideRoom(roomId)
        store.update { it.markHidden(roomId, row.id) }
    }

    suspend fun unhide(roomId: String) {
        val row = store.get().hidden[roomId] ?: return
        api.unhideRoom(row)
        store.update { it.unmarkHidden(row) }
    }

    suspend fun setArchived(roomId: String, archived: Boolean) {
        val r = api.setArchived(roomId, archived)
        store.update { it.upsertRoom(r) }
    }

    /** Who can see the room (§23.2) and, with [posting], who can post (§23.6). Creator only. */
    suspend fun setAccess(roomId: String, visibility: Visibility, members: List<String>, posting: Posting? = null, writers: List<String> = emptyList()) {
        val r = api.setAccess(roomId, visibility, members, posting, writers)
        store.update { it.upsertRoom(r) }
    }

    /** Open (or reopen) the DM with [userId] (§16.2). Already open: no request (the route is rate limited, QA BUG-30). */
    suspend fun openDm(userId: String): Room {
        val s = store.get()
        s.rooms.values.firstOrNull { it.isDm && userId in it.members && s.user?.id in it.members && it.id !in s.hidden }?.let { return it }
        val room = api.openDm(userId)
        store.update { it.upsertRoom(room).unmarkHiddenRoom(room.id) }
        return room
    }
}
