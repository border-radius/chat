// A room's mark (DESIGN.md §23): # for a public room, a lock for a private one, a globe for an Open Air one, on a
// soft tile of the accent colour.
package chat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import chat.android.data.lib.otherMember
import chat.android.data.lib.visibilityOrDefault
import chat.android.data.model.Room
import chat.android.data.model.Visibility

fun Visibility.icon(): ImageVector = when (this) {
    Visibility.Private -> ChatIcons.Lock
    Visibility.Open -> ChatIcons.Globe
    Visibility.Public -> ChatIcons.Tag
}

@Composable
fun RoomIcon(visibility: Visibility, size: Dp = 40.dp, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).background(Chat.colors.tint, RoundedCornerShape(size * 0.32f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(visibility.icon(), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(size * 0.5f))
    }
}

/** A room's picture in a list: the other person's avatar for a DM, the room's mark otherwise. */
@Composable
fun RoomPicture(room: Room, me: String?, size: Dp = 40.dp) {
    val other = if (room.isDm) room.otherMember(me) else null
    if (other != null) Avatar(other, size) else RoomIcon(room.visibilityOrDefault, size)
}
