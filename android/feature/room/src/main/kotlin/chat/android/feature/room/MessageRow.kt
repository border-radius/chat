// One message in the list (DESIGN.md §7.6, §17.5, §19, §20.3, §21.3, §28): author and time at the start of a group,
// the text with its links, a reply's quote, a forward's origin, attachments, link previews, reactions, and how its send
// is going.
package chat.android.feature.room

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.launch
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.withStyle
import chat.android.data.lib.isEmptyForward
import chat.android.data.lib.line
import chat.android.data.lib.reactors
import chat.android.data.model.Message
import chat.android.data.model.Reaction
import chat.android.data.model.SendStatus
import chat.android.data.model.User
import chat.android.ui.Avatar
import chat.android.ui.Chat
import chat.android.ui.ChatIcons
import chat.android.ui.Formats
import chat.android.ui.linked
import chat.android.ui.openLink
import coil3.compose.AsyncImage

/** What a row can do; the screen decides what each one means. */
class RowActions(
    val onLongPress: (Message) -> Unit,
    val onTap: (Message) -> Unit,
    val onQuote: (String) -> Unit,
    val onReact: (Message, String) -> Unit,
    val onRetry: (Message) -> Unit,
    val onDiscard: (Message) -> Unit,
    val onOpenMedia: (Message, String) -> Unit,
    val onFile: (Message, String) -> Unit,
    val reactions: (Message) -> List<Reaction>,
    val name: (String) -> String?,
    val progress: (String) -> Float?,
    /** The emoji picker for a reaction, or null where you can't react (a guest, an archived room). */
    val onAddReaction: ((Message) -> Unit)? = null,
    /** Swiping a message to the right replies to it (ANDROID.md §3), or null where you can't reply. */
    val onSwipeReply: ((Message) -> Unit)? = null,
)

/** How far a message is dragged before letting go replies to it. */
private val SWIPE_REPLY = 64.dp

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun MessageRow(
    m: Message,
    first: Boolean,
    target: Boolean,
    me: String?,
    selecting: Boolean,
    selected: Boolean,
    actions: RowActions,
) {
    if (m.isService) return ServiceRow(m)
    val context = LocalContext.current
    val highlight by animateColorAsState(if (target) Chat.colors.highlight else Color.Transparent, tween(if (target) 150 else 1200), label = "target")
    val author = m.expand?.author ?: User(m.author, "Unknown")
    val accent = MaterialTheme.colorScheme.primary
    val swipe = remember { androidx.compose.animation.core.Animatable(0f) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val threshold = with(androidx.compose.ui.platform.LocalDensity.current) { SWIPE_REPLY.toPx() }
    val canSwipe = actions.onSwipeReply != null && !selecting && m.status == null && !m.deleted
    Box {
        if (canSwipe && swipe.value > 0f) {
            Icon(
                ChatIcons.Reply,
                contentDescription = null,
                tint = accent,
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 16.dp)
                    .size(24.dp)
                    .graphicsLayer {
                        val p = (swipe.value / threshold).coerceIn(0f, 1f)
                        alpha = p
                        scaleX = 0.6f + 0.4f * p
                        scaleY = 0.6f + 0.4f * p
                    },
            )
        }
        Row(
            Modifier
                .fillMaxWidth()
                .offset { androidx.compose.ui.unit.IntOffset(swipe.value.toInt(), 0) }
                .then(
                    if (!canSwipe) Modifier else Modifier.pointerInput(m.id) {
                        var armed = false
                        detectHorizontalDragGestures(
                            onDragStart = { armed = false },
                            onDragEnd = {
                                if (swipe.value >= threshold) actions.onSwipeReply?.invoke(m)
                                scope.launch { swipe.animateTo(0f, androidx.compose.animation.core.spring(dampingRatio = 0.7f)) }
                            },
                            onDragCancel = { scope.launch { swipe.animateTo(0f) } },
                            onHorizontalDrag = { change, dx ->
                                // Only to the right, harder to pull past the threshold.
                                val now = swipe.value
                                val next = (now + if (now > threshold) dx * 0.3f else dx).coerceIn(0f, threshold * 1.6f)
                                if (next != now) change.consume()
                                if (!armed && next >= threshold) {
                                    armed = true
                                    haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                                } else if (next < threshold) armed = false
                                scope.launch { swipe.snapTo(next) }
                            },
                        )
                    },
                )
                .background(if (selected) Chat.colors.tint else highlight)
                .combinedClickable(
                    onClick = { actions.onTap(m) },
                    onLongClick = { actions.onLongPress(m) },
                    onLongClickLabel = "Message actions",
                )
                .padding(start = 12.dp, end = 12.dp, top = if (first) 10.dp else 1.dp, bottom = 1.dp)
                .semantics { if (selecting) stateDescription = if (selected) "Selected" else "Not selected" },
        ) {
            if (selecting) {
                Checkbox(selected, onCheckedChange = null, modifier = Modifier.padding(end = 4.dp))
            }
            Box(Modifier.width(40.dp)) { if (first) Avatar(author, 36.dp) }
            Column(Modifier.weight(1f)) {
                if (first) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(author.name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        Text(Formats.time(m.created), color = Chat.colors.muted, style = MaterialTheme.typography.labelSmall)
                    }
                }
                if (m.forwardedFrom.isNotEmpty()) {
                    Text("Forwarded from ${m.expand?.forwardedFrom?.name ?: "Unknown"}", color = Chat.colors.muted, style = MaterialTheme.typography.labelMedium, fontStyle = FontStyle.Italic)
                }
                m.expand?.replyTo?.takeIf { m.replyTo.isNotEmpty() }?.let { q ->
                    val name = q.expand?.author?.name.orEmpty()
                    Row(
                        Modifier
                            .padding(vertical = 2.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(MaterialTheme.colorScheme.surfaceContainer)
                            .clickable(onClickLabel = "Show the original message") { actions.onQuote(q.id) }
                            .padding(horizontal = 8.dp, vertical = 4.dp)
                            .semantics(mergeDescendants = true) { contentDescription = "Quoting ${name.ifEmpty { "a message" }}: ${q.line()}" },
                    ) {
                        Box(Modifier.width(3.dp).height(32.dp).background(accent, RoundedCornerShape(2.dp)))
                        Spacer(Modifier.width(8.dp))
                        Column {
                            if (name.isNotEmpty()) Text(name, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = accent)
                            Text(q.line(), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Chat.colors.muted)
                        }
                    }
                }
                when {
                    m.deleted -> Text("Message deleted", color = Chat.colors.muted, fontStyle = FontStyle.Italic)
                    m.isEmptyForward() -> Text("The original message was deleted", color = Chat.colors.muted, fontStyle = FontStyle.Italic)
                    else -> {
                        if (m.text.isNotEmpty()) {
                            val muted = Chat.colors.muted
                            val edited = m.editedAt.isNotEmpty()
                            // "(edited)" follows the text on its line, as on the web.
                            val text = remember(m.text, accent, edited, muted) {
                                val t = linked(m.text, accent) { openLink(context, it) }
                                if (!edited) t else androidx.compose.ui.text.buildAnnotatedString {
                                    append(t)
                                    append(" ")
                                    withStyle(androidx.compose.ui.text.SpanStyle(color = muted, fontSize = 12.sp)) { append("(edited)") }
                                }
                            }
                            Text(text, style = MaterialTheme.typography.bodyLarge, modifier = if (edited) Modifier.semantics { stateDescription = "Edited ${Formats.full(m.editedAt)}" } else Modifier)
                        } else if (m.editedAt.isNotEmpty()) {
                            Text("(edited)", color = Chat.colors.muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.semantics { contentDescription = "Edited ${Formats.full(m.editedAt)}" })
                        }
                        Attachments(m, actions)
                        for (p in m.previews) LinkPreviewRow(p.url, p.title, p.icon)
                    }
                }
                val reactions = actions.reactions(m)
                if (reactions.isNotEmpty() && !m.deleted) {
                    FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (r in reactions) {
                            val mine = me != null && me in r.users
                            val who = reactors(r.users, me.orEmpty(), actions.name)
                            Row(
                                Modifier
                                    .heightIn(min = 32.dp)
                                    .clip(RoundedCornerShape(16.dp))
                                    .background(if (mine) Chat.colors.tint else MaterialTheme.colorScheme.surfaceContainer)
                                    .border(1.dp, if (mine) accent else Chat.colors.border, RoundedCornerShape(16.dp))
                                    .clickable(enabled = me != null) { actions.onReact(m, r.emoji) }
                                    .padding(horizontal = 10.dp, vertical = 4.dp)
                                    .semantics(mergeDescendants = true) {
                                        contentDescription = "$who reacted with ${r.emoji}"
                                        stateDescription = if (mine) "Yours" else ""
                                    },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(r.emoji)
                                Spacer(Modifier.width(4.dp))
                                Text(r.users.size.toString(), style = MaterialTheme.typography.labelMedium, color = if (mine) accent else MaterialTheme.colorScheme.onSurface)
                            }
                        }
                        // As on the web: one more chip, to add a reaction.
                        actions.onAddReaction?.let { add ->
                            Box(
                                Modifier
                                    .height(32.dp)
                                    .clip(RoundedCornerShape(16.dp))
                                    .border(1.dp, Chat.colors.border, RoundedCornerShape(16.dp))
                                    .clickable { add(m) }
                                    .padding(horizontal = 10.dp)
                                    .semantics { contentDescription = "Add reaction" },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(ChatIcons.AddReaction, contentDescription = null, tint = Chat.colors.muted, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                }
                SendState(m, actions)
            }
        }
    }
}

@Composable
private fun SendState(m: Message, actions: RowActions) {
    when (m.status) {
        SendStatus.Pending -> {
            val p = actions.progress(m.id)
            if (m.localFiles.isNotEmpty() && p != null) {
                LinearProgressIndicator(progress = { p }, modifier = Modifier.padding(top = 4.dp).widthIn(max = 240.dp).fillMaxWidth().semantics { contentDescription = "Uploading" })
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                    Icon(ChatIcons.Pending, contentDescription = "Sending", tint = Chat.colors.muted, modifier = Modifier.size(14.dp))
                }
            }
        }
        SendStatus.Failed -> {
            val replyGone = m.replyTo.isEmpty() && m.expand?.replyTo?.deleted == true
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(ChatIcons.Error, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text(
                    if (replyGone) "Not sent: the message you replied to was deleted." else "Not sent.",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f, fill = false),
                )
                TextButton(onClick = { actions.onRetry(m) }) { Text(if (replyGone) "Send without quote" else "Retry") }
                TextButton(onClick = { actions.onDiscard(m) }) { Text("Discard") }
            }
        }
        null -> {}
    }
}

@Composable
private fun ServiceRow(m: Message) {
    Text(
        m.text,
        color = Chat.colors.muted,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
    )
}

@Composable
private fun LinkPreviewRow(url: String, title: String, icon: String) {
    if (title.isEmpty()) return
    val context = LocalContext.current
    Row(
        Modifier
            .padding(top = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, Chat.colors.border, RoundedCornerShape(8.dp))
            .clickable { openLink(context, url) }
            .padding(horizontal = 8.dp, vertical = 6.dp)
            .widthIn(max = 360.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon.startsWith("data:image/")) {
            AsyncImage(icon, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(title, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
