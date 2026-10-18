// What opens over the room: a message's actions (with quick reactions, §20.2), the emoji picker (§20.4: exactly the
// emoji the server accepts as reactions) and the forward target picker (§21.3).
package chat.android.feature.room

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import chat.android.data.lib.EMOJI_CATEGORIES
import chat.android.data.lib.QUICK_REACTIONS
import chat.android.data.lib.canPost
import chat.android.data.lib.roomSections
import chat.android.data.lib.title
import chat.android.data.model.Message
import chat.android.data.model.Room
import chat.android.data.repo.AppState
import chat.android.ui.Chat
import chat.android.ui.ChatIcons

class MenuItem(val label: String, val icon: ImageVector, val run: () -> Unit)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageSheet(
    m: Message,
    reactable: Boolean,
    recent: List<String>,
    items: List<MenuItem>,
    onReact: (String) -> Unit,
    onMoreEmoji: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        if (reactable) {
            val quick = (recent + QUICK_REACTIONS).distinct().take(6)
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                for (e in quick) {
                    Box(
                        Modifier.size(48.dp).clip(CircleShape).clickable { onReact(e) }.semantics { contentDescription = "React with $e" },
                        contentAlignment = Alignment.Center,
                    ) { Text(e, fontSize = 26.sp) }
                }
                Box(Modifier.size(48.dp).clip(CircleShape).clickable(onClick = onMoreEmoji), contentAlignment = Alignment.Center) {
                    Icon(ChatIcons.Add, contentDescription = "Add reaction")
                }
            }
        }
        for (item in items) {
            ListItem(
                headlineContent = { Text(item.label) },
                leadingContent = { Icon(item.icon, contentDescription = null) },
                modifier = Modifier.clickable { item.run() },
            )
        }
        Box(Modifier.height(24.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmojiSheet(title: String, recent: List<String>, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp).semantics { heading() })
        LazyVerticalGrid(GridCells.Adaptive(48.dp), Modifier.fillMaxWidth().height(360.dp).padding(horizontal = 8.dp)) {
            if (recent.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) { CategoryTitle("Recent") }
                items(recent, key = { "r$it" }) { e -> EmojiCell(e, onPick) }
            }
            for (c in EMOJI_CATEGORIES) {
                item(span = { GridItemSpan(maxLineSpan) }, key = "c-${c.name}") { CategoryTitle(c.name) }
                items(c.emoji, key = { "${c.name}$it" }) { e -> EmojiCell(e, onPick) }
            }
        }
    }
}

@Composable
private fun CategoryTitle(name: String) {
    Text(name, style = MaterialTheme.typography.labelLarge, color = Chat.colors.muted, modifier = Modifier.padding(start = 8.dp, top = 12.dp, bottom = 4.dp).semantics { heading() })
}

@Composable
private fun EmojiCell(e: String, onPick: (String) -> Unit) {
    Box(Modifier.size(48.dp).clip(CircleShape).clickable { onPick(e) }, contentAlignment = Alignment.Center) { Text(e, fontSize = 26.sp) }
}

/** Where messages can be forwarded: the rooms and DMs I may post in (§21.3). */
fun forwardTargets(s: AppState): List<Room> {
    val me = s.user?.id
    val sections = roomSections(s.rooms.values, s.hidden.keys, me, s.activeRoomId)
    return (sections.dms + sections.rooms + sections.hidden).filter { !it.archived && it.canPost(me) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForwardSheet(count: Int, rooms: List<Room>, me: String?, onPick: (Room) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(if (count == 1) "Forward message" else "Forward $count messages", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp).semantics { heading() })
        Text("Forward to", color = Chat.colors.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        LazyColumn(Modifier.fillMaxWidth().height(420.dp)) {
            items(rooms, key = { it.id }) { r ->
                ListItem(headlineContent = { Text(r.title(me), maxLines = 1, overflow = TextOverflow.Ellipsis) }, modifier = Modifier.clickable { onPick(r) })
            }
        }
    }
}
