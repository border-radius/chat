// The composer (ANDROID.md §7.2, DESIGN.md §22.3): a multi-line field with the 2,000-character limit counted in code
// points, emoji, attach and send. Enter makes a new line; with a hardware keyboard Enter sends, Shift+Enter is a new
// line, Up in an empty field edits your last message and Ctrl+Up/Down pick the reply, as on the web.
package chat.android.feature.room

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import chat.android.data.lib.Limits
import chat.android.data.lib.isBlank
import chat.android.data.lib.quote
import chat.android.data.lib.line
import chat.android.data.lib.textLength
import chat.android.ui.Chat
import chat.android.ui.ChatIcons

@Composable
fun Composer(vm: RoomViewModel, placeholder: String, focus: FocusRequester, onEmoji: () -> Unit) {
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(Limits.ATTACHMENTS)) { vm.attach(it) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { vm.attach(it) }
    var attachMenu by remember { mutableStateOf(false) }
    Surface(tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth()) {
            vm.editing?.let {
                Bar("Edit message", "Enter to save · Esc to cancel", "Cancel edit", vm::cancelEdit)
            }
            vm.replyTo?.let { r ->
                Bar("Replying to ${r.expand?.author?.name ?: "Unknown"}", r.quote().line(), "Cancel reply", vm::cancelReply)
            }
            if (vm.attachments.isNotEmpty()) {
                LazyRow(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    items(vm.attachments, key = { it.uri }) { f ->
                        // An image shows itself; other files their name.
                        if (f.type.startsWith("image/")) {
                            Box(Modifier.size(64.dp)) {
                                coil3.compose.AsyncImage(
                                    java.io.File(f.uri),
                                    contentDescription = f.name,
                                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                    modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest),
                                )
                                Box(
                                    Modifier
                                        .align(Alignment.TopEnd)
                                        .padding(3.dp)
                                        .size(22.dp)
                                        .clip(androidx.compose.foundation.shape.CircleShape)
                                        .background(Color.Black.copy(alpha = 0.6f))
                                        .clickable { vm.removeAttachment(f) }
                                        .semantics { contentDescription = "Remove ${f.name}" },
                                    contentAlignment = Alignment.Center,
                                ) { Icon(ChatIcons.Close, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp)) }
                            }
                            return@items
                        }
                        InputChip(
                            selected = false,
                            onClick = { vm.removeAttachment(f) },
                            label = { Text(f.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(120.dp)) },
                            trailingIcon = { Icon(ChatIcons.Close, contentDescription = "Remove ${f.name}", modifier = Modifier.size(16.dp)) },
                        )
                    }
                }
            }
            val n = textLength(vm.text.text)
            val error = vm.composerError.ifEmpty { if (n > Limits.MESSAGE_TEXT) "Too long: ${n - Limits.MESSAGE_TEXT} characters over the ${Limits.MESSAGE_TEXT} limit." else "" }
            if (error.isNotEmpty()) {
                Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite })
            }
            Row(Modifier.padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.Bottom) {
                IconButton(onClick = onEmoji) { Icon(ChatIcons.Emoji, contentDescription = "Insert emoji", tint = Chat.colors.muted) }
                if (vm.editing == null) {
                    Box {
                        IconButton(onClick = { attachMenu = true }) { Icon(ChatIcons.Attach, contentDescription = "Attach files", tint = Chat.colors.muted) }
                        DropdownMenu(attachMenu, onDismissRequest = { attachMenu = false }) {
                            DropdownMenuItem(text = { Text("Photos and videos") }, onClick = {
                                attachMenu = false
                                pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                            })
                            DropdownMenuItem(text = { Text("Files") }, onClick = { attachMenu = false; pickFiles.launch(arrayOf("*/*")) })
                        }
                    }
                }
                TextField(
                    value = vm.text,
                    onValueChange = vm::onText,
                    placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    maxLines = 6,
                    shape = RoundedCornerShape(20.dp),
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    ),
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .focusRequester(focus)
                        .semantics { contentDescription = "Message" }
                        .onPreviewKeyEvent { e ->
                            if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                            when {
                                e.key == Key.Enter && !e.isShiftPressed -> { vm.submit(); true }
                                e.key == Key.Escape && vm.editing != null -> { vm.cancelEdit(); true }
                                e.key == Key.Escape && vm.replyTo != null -> { vm.cancelReply(); true }
                                e.key == Key.DirectionUp && e.isCtrlPressed -> { vm.moveReply(up = true); true }
                                e.key == Key.DirectionDown && e.isCtrlPressed -> { vm.moveReply(up = false); true }
                                e.key == Key.DirectionUp && vm.text.text.isEmpty() -> vm.editLast()
                                else -> false
                            }
                        },
                )
                val canSend = (!isBlank(vm.text.text) || (vm.attachments.isNotEmpty() && vm.editing == null)) && n <= Limits.MESSAGE_TEXT
                Spacer(Modifier.width(6.dp))
                val bg by androidx.compose.animation.animateColorAsState(if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh, label = "send")
                val fg by androidx.compose.animation.animateColorAsState(if (canSend) MaterialTheme.colorScheme.onPrimary else Chat.colors.muted, label = "sendIcon")
                androidx.compose.material3.FilledIconButton(
                    onClick = vm::submit,
                    enabled = canSend,
                    colors = androidx.compose.material3.IconButtonDefaults.filledIconButtonColors(containerColor = bg, contentColor = fg, disabledContainerColor = bg, disabledContentColor = fg),
                    modifier = Modifier.padding(bottom = 2.dp).size(44.dp),
                ) {
                    Icon(if (vm.editing != null) ChatIcons.Check else ChatIcons.Send, contentDescription = if (vm.editing != null) "Save" else "Send", modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(4.dp))
            }
        }
    }
}

@Composable
private fun Bar(title: String, detail: String, cancel: String, onCancel: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(3.dp).heightIn(min = 32.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Text(detail, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Chat.colors.muted)
        }
        IconButton(onClick = onCancel) { Icon(ChatIcons.Close, contentDescription = cancel) }
    }
    HorizontalDivider(color = Chat.colors.border)
}
