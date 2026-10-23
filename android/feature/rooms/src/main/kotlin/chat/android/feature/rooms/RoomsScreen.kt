// The room list (DESIGN.md §5, §16.5, §18.4; web/src/views/rooms.ts): DMs, rooms, your media collections and those you
// follow (§31.3), and the hidden and archived rooms folded away; unread badges; a row's menu (hide, close, archive). A
// guest sees the Open Air rooms (§23.3).
package chat.android.feature.rooms

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chat.android.data.api.ApiError
import chat.android.data.api.errorMessage
import chat.android.data.lib.Limits
import chat.android.data.lib.hint
import chat.android.data.lib.label
import chat.android.data.lib.otherMember
import chat.android.data.lib.roomSections
import chat.android.data.lib.textLength
import chat.android.data.lib.title
import chat.android.data.lib.unreadBadge
import chat.android.data.lib.visibilityOrDefault
import chat.android.data.model.Room
import chat.android.data.model.Visibility
import chat.android.data.repo.AppState
import chat.android.data.repo.LoadStatus
import chat.android.ui.Avatar
import chat.android.ui.Chat
import chat.android.ui.ChatIcons
import chat.android.ui.LocalServices
import chat.android.ui.UserSearchDialog
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import chat.android.data.lib.jumpMatches
import chat.android.data.lib.jumpTargets

private enum class Section { Rooms, Dms, Hidden, Archived }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomsScreen(onOpenRoom: (String) -> Unit, onProfile: () -> Unit, onLogIn: () -> Unit, onOpenCollection: (String) -> Unit = {}) {
    val services = LocalServices.current
    val s by services.store.flow.collectAsStateWithLifecycle()
    val me = s.user
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var newRoom by rememberSaveable { mutableStateOf(false) }
    var newDm by rememberSaveable { mutableStateOf(false) }
    var newCollection by rememberSaveable { mutableStateOf(false) }
    var archiving by remember { mutableStateOf<Room?>(null) }
    val sections = remember(s.rooms, s.hidden, me, s.activeRoomId) { roomSections(s.rooms.values, s.hidden.keys, me?.id, s.activeRoomId) }

    fun act(label: String, room: Room, block: suspend () -> Unit) {
        scope.launch {
            runCatching { block() }.onFailure { e ->
                snackbar.showSnackbar("Couldn't $label “${if (room.isDm) room.title(me?.id) else room.name}”. ${errorMessage(e)}")
            }
        }
    }

    var jumping by rememberSaveable { mutableStateOf(false) }
    var jumpQuery by rememberSaveable { mutableStateOf("") }
    fun closeJump() { jumping = false; jumpQuery = "" }
    androidx.activity.compose.BackHandler(enabled = jumping, onBack = ::closeJump)

    Scaffold(
        // Ctrl+K or Ctrl+P from a hardware keyboard: Jump to (§32), as on the web.
        modifier = Modifier.onPreviewKeyEvent { e ->
            if (e.type == KeyEventType.KeyDown && e.isCtrlPressed && !e.isAltPressed && !e.isShiftPressed && (e.key == Key.K || e.key == Key.P)) {
                if (jumping) closeJump() else jumping = true
                true
            } else false
        },
        topBar = {
            if (jumping) {
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { focus.requestFocus() }
                TopAppBar(
                    navigationIcon = { IconButton(onClick = ::closeJump) { Icon(ChatIcons.Back, contentDescription = "Close search") } },
                    title = {
                        androidx.compose.material3.TextField(
                            jumpQuery,
                            { jumpQuery = it },
                            placeholder = { Text("Jump to a room or person", maxLines = 1) },
                            singleLine = true,
                            colors = androidx.compose.material3.TextFieldDefaults.colors(
                                focusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                                unfocusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                                focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                                unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                            ),
                            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Go),
                            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = {
                                jumpMatches(jumpTargets(sections, me?.id), jumpQuery).firstOrNull()?.let { closeJump(); onOpenRoom(it.room.id) }
                            }),
                            modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "Jump to" },
                        )
                    },
                    actions = {
                        if (jumpQuery.isNotEmpty()) IconButton(onClick = { jumpQuery = "" }) { Icon(ChatIcons.Close, contentDescription = "Clear") }
                    },
                )
                return@Scaffold
            }
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        chat.android.ui.BrandMark(s.site.logo, 32.dp)
                        Column {
                            Text(s.site.title, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            // Which account this is, once there are several (ANDROID.md §17.2).
                            val many = (chat.android.ui.LocalAccounts.current?.list?.collectAsStateWithLifecycle()?.value?.count { it.user != null } ?: 0) > 1
                            if (many) Text(chat.android.data.lib.serverLabel(services.server), style = androidx.compose.material3.MaterialTheme.typography.bodySmall, color = chat.android.ui.Chat.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { jumping = true }) { Icon(ChatIcons.Search, contentDescription = "Jump to a room or person") }
                    if (me != null) {
                        IconButton(onClick = onProfile, modifier = Modifier.semantics { contentDescription = "Profile" }) { Avatar(me, 32.dp) }
                    } else {
                        TextButton(onClick = onLogIn) { Text("Log in") }
                    }
                },
            )
        },
        floatingActionButton = {
            if (me != null && !jumping) {
                var menu by remember { mutableStateOf(false) }
                Box {
                    FloatingActionButton(onClick = { menu = true }) { Icon(ChatIcons.Add, contentDescription = "New") }
                    DropdownMenu(menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("New room") }, leadingIcon = { Icon(ChatIcons.Tag, contentDescription = null) }, onClick = { menu = false; newRoom = true })
                        DropdownMenuItem(text = { Text("New message") }, leadingIcon = { Icon(ChatIcons.Chat, contentDescription = null) }, onClick = { menu = false; newDm = true })
                        DropdownMenuItem(text = { Text("New collection") }, leadingIcon = { Icon(ChatIcons.Collection, contentDescription = null) }, onClick = { menu = false; newCollection = true })
                    }
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        if (jumping) {
            val found = remember(sections, jumpQuery, me) { jumpMatches(jumpTargets(sections, me?.id), jumpQuery) }
            LazyColumn(Modifier.fillMaxSize().semantics { contentDescription = "Rooms" }, contentPadding = padding) {
                if (found.isEmpty()) empty("Nothing found.")
                items(found, key = { "j" + it.room.id }) { t ->
                    JumpRow(t, s, me?.id) { closeJump(); onOpenRoom(t.room.id) }
                }
            }
            return@Scaffold
        }
        var showHidden by rememberSaveable { mutableStateOf(false) }
        var showArchived by rememberSaveable { mutableStateOf(false) }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + 88.dp)) {
            // The first load: a spinner, not an empty list that fills in.
            if (s.rooms.isEmpty() && (s.roomsStatus == LoadStatus.Loading || s.roomsStatus == LoadStatus.Idle)) {
                item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                        androidx.compose.material3.CircularProgressIndicator(Modifier.size(32.dp).semantics { contentDescription = "Loading rooms" })
                    }
                }
                return@LazyColumn
            }
            if (s.roomsStatus == LoadStatus.Error && s.rooms.isEmpty()) {
                item {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Couldn't load rooms. Check your connection. ", Modifier.weight(1f))
                        TextButton(onClick = { scope.launch { services.rooms.reload() } }) { Text("Retry") }
                    }
                }
            }
            if (me == null) {
                header("Open Air rooms")
                if (sections.rooms.isEmpty() && s.roomsStatus == LoadStatus.Ready) empty("No Open Air rooms yet. Log in to see the others.")
                items(sections.rooms, key = { it.id }) { r -> RoomRow(r, s, me?.id, onOpenRoom, emptyList()) }
                return@LazyColumn
            }
            if (sections.dms.isNotEmpty()) {
                header("Direct messages")
                items(sections.dms, key = { it.id }) { r ->
                    RoomRow(r, s, me.id, onOpenRoom, listOf("Close conversation" to { act("close", r) { services.actions.hide(r.id) } }))
                }
            }
            header("Rooms")
            if (sections.rooms.isEmpty() && s.roomsStatus == LoadStatus.Ready) {
                empty(if (sections.hidden.isNotEmpty() || sections.archived.isNotEmpty()) "No other rooms. Hidden and archived ones are listed below." else "No rooms yet. Create the first one.")
            }
            items(sections.rooms, key = { it.id }) { r -> RoomRow(r, s, me.id, onOpenRoom, menuItems(r, Section.Rooms, s, me.id, ::act, { archiving = it }, services)) }
            collections(s.collections, onOpenCollection) { newCollection = true }
            if (sections.hidden.isNotEmpty()) {
                fold("Hidden", sections.hidden.size, showHidden) { showHidden = !showHidden }
                if (showHidden) items(sections.hidden, key = { "h" + it.id }) { r -> RoomRow(r, s, me.id, onOpenRoom, menuItems(r, Section.Hidden, s, me.id, ::act, { archiving = it }, services)) }
            }
            if (sections.archived.isNotEmpty()) {
                fold("Archived", sections.archived.size, showArchived) { showArchived = !showArchived }
                if (showArchived) items(sections.archived, key = { "a" + it.id }) { r -> RoomRow(r, s, me.id, onOpenRoom, menuItems(r, Section.Archived, s, me.id, ::act, { archiving = it }, services)) }
            }
        }
    }

    archiving?.let { r ->
        AlertDialog(
            onDismissRequest = { archiving = null },
            title = { Text("Archive room") },
            text = { Text("Archive “${r.name}”? It becomes read-only for everyone.") },
            confirmButton = { TextButton(onClick = { archiving = null; act("archive", r) { services.actions.setArchived(r.id, true) } }) { Text("Archive") } },
            dismissButton = { TextButton(onClick = { archiving = null }) { Text("Cancel") } },
        )
    }
    if (newCollection) chat.android.ui.NewCollectionDialog(onCreated = { newCollection = false; onOpenCollection(it) }, onDismiss = { newCollection = false })
    if (newRoom) NewRoomDialog(onCreated = { newRoom = false; onOpenRoom(it.id) }, onDismiss = { newRoom = false })
    if (newDm) {
        UserSearchDialog(
            title = "New message",
            onPick = { u ->
                newDm = false
                scope.launch {
                    runCatching { services.actions.openDm(u.id) }
                        .onSuccess { onOpenRoom(it.id) }
                        .onFailure { e -> snackbar.showSnackbar("Couldn't open the conversation with “${u.name}”. ${errorMessage(e)}") }
                }
            },
            onDismiss = { newDm = false },
            exclude = setOfNotNull(me?.id),
        )
    }
}

private fun menuItems(
    r: Room,
    section: Section,
    s: AppState,
    me: String,
    act: (String, Room, suspend () -> Unit) -> Unit,
    archive: (Room) -> Unit,
    services: chat.android.data.repo.ChatServices,
): List<Pair<String, () -> Unit>> {
    val mine = r.createdBy == me
    val items = mutableListOf<Pair<String, () -> Unit>>()
    if (section == Section.Rooms) items += "Hide" to { act("hide", r) { services.actions.hide(r.id) } }
    // An archived room you had hidden is listed under Archived; it can still be unhidden from there.
    if (section == Section.Hidden || (section == Section.Archived && r.id in s.hidden)) items += "Unhide" to { act("unhide", r) { services.actions.unhide(r.id) } }
    if (mine && section != Section.Archived) items += "Archive" to { archive(r) }
    if (mine && section == Section.Archived) items += "Unarchive" to { act("unarchive", r) { services.actions.setArchived(r.id, false) } }
    return items
}

@Composable
private fun JumpRow(t: chat.android.data.lib.JumpTarget, s: AppState, me: String?, onOpen: () -> Unit) {
    val badge = unreadBadge(t.room, s.unread, s.hidden.keys, s.activeRoomId)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        chat.android.ui.RoomPicture(t.room, me)
        Text(t.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (badge > 0) FontWeight.Bold else FontWeight.Normal)
        if (t.note.isNotEmpty()) Text(t.note, style = MaterialTheme.typography.labelMedium, color = Chat.colors.muted)
        if (badge > 0) UnreadBadge(badge)
    }
}

@Composable
private fun UnreadBadge(badge: Int) {
    Box(
        Modifier.heightIn(min = 22.dp).widthIn(min = 22.dp).background(Chat.colors.gradient, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (badge > 99) "99+" else badge.toString(),
            color = androidx.compose.ui.graphics.Color.White,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.semantics { contentDescription = "$badge unread" },
        )
    }
}

private fun LazyListScope.header(text: String) = item(key = "header-$text") {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = Chat.colors.muted,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() },
    )
}

/** Yours (🔒 when private), then those you follow with their owner's name and how many items are new (§31.3). */
private fun LazyListScope.collections(c: chat.android.data.model.Collections?, onOpen: (String) -> Unit, onNew: () -> Unit) {
    item(key = "header-collections") {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Collections", style = MaterialTheme.typography.titleSmall, color = Chat.colors.muted, modifier = Modifier.weight(1f).semantics { heading() })
            IconButton(onClick = onNew) { Icon(ChatIcons.Add, contentDescription = "New collection", tint = Chat.colors.muted) }
        }
    }
    if (c == null) return
    if (c.mine.isEmpty() && c.subs.isEmpty()) empty("No collections yet. Save images and videos from the chat to one.")
    items(c.mine, key = { "c" + it.id }) { CollectionRow(it, onOpen) }
    items(c.subs, key = { "s" + it.id }) { CollectionRow(it, onOpen) }
}

@Composable
private fun CollectionRow(c: chat.android.data.model.MediaCollection, onOpen: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable { onOpen(c.id) }
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape), contentAlignment = Alignment.Center) {
            Icon(ChatIcons.Collection, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
        }
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(c.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (c.new > 0) FontWeight.Bold else FontWeight.Normal, modifier = Modifier.weight(1f, fill = false))
            if (c.owner == null && !c.public) Icon(ChatIcons.Lock, contentDescription = "private", tint = Chat.colors.muted, modifier = Modifier.size(14.dp))
            c.owner?.let { Text("· ${it.name}", color = Chat.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        if (c.new > 0) {
            Box(
                Modifier.heightIn(min = 22.dp).widthIn(min = 22.dp).background(Chat.colors.gradient, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (c.new > 99) "99+" else c.new.toString(),
                    color = androidx.compose.ui.graphics.Color.White,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.semantics { contentDescription = "${c.new} new" },
                )
            }
        }
    }
}

private fun LazyListScope.empty(text: String) = item(key = "empty-$text") {
    Text(text, color = Chat.colors.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

private fun LazyListScope.fold(text: String, count: Int, open: Boolean, toggle: () -> Unit) = item(key = "fold-$text") {
    Row(
        Modifier.fillMaxWidth().clickable(onClickLabel = if (open) "Collapse" else "Expand", onClick = toggle).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("$text ($count)", style = MaterialTheme.typography.titleSmall, color = Chat.colors.muted, modifier = Modifier.weight(1f).semantics { heading() })
        Icon(ChatIcons.Down, contentDescription = null, tint = Chat.colors.muted, modifier = Modifier.rotate(if (open) 180f else 0f))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RoomRow(r: Room, s: AppState, me: String?, onOpen: (String) -> Unit, menu: List<Pair<String, () -> Unit>>) {
    var open by remember { mutableStateOf(false) }
    val badge = unreadBadge(r, s.unread, s.hidden.keys, s.activeRoomId)
    val title = r.title(me)
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .combinedClickable(onClick = { onOpen(r.id) }, onLongClick = if (menu.isNotEmpty()) ({ open = true }) else null, onLongClickLabel = "Actions for $title")
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (r.isDm) {
                r.otherMember(me)?.let { Avatar(it, 40.dp) }
            } else {
                chat.android.ui.RoomIcon(r.visibilityOrDefault, 40.dp)
            }
            Text(
                if (r.isDm) title else r.name,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontWeight = if (badge > 0) FontWeight.Bold else FontWeight.Normal,
                color = if (r.archived) Chat.colors.muted else MaterialTheme.colorScheme.onSurface,
            )
            if (badge > 0) UnreadBadge(badge)
            if (menu.isNotEmpty()) {
                // The menu opens at the button (a long press on the row opens it there too).
                Box {
                    IconButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = "Actions for $title" }) {
                        Icon(ChatIcons.More, contentDescription = null, tint = Chat.colors.muted)
                    }
                    DropdownMenu(open, onDismissRequest = { open = false }) {
                        for ((label, run) in menu) {
                            DropdownMenuItem(text = { Text(label) }, leadingIcon = { Icon(menuIcon(label), contentDescription = null) }, onClick = { open = false; run() })
                        }
                    }
                }
            }
        }
    }
}

private fun menuIcon(label: String) = when (label) {
    "Unhide" -> ChatIcons.Show
    "Archive", "Unarchive" -> ChatIcons.Archive
    else -> ChatIcons.Hide
}

@Composable
private fun NewRoomDialog(onCreated: (Room) -> Unit, onDismiss: () -> Unit) {
    val services = LocalServices.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var visibility by rememberSaveable { mutableStateOf(Visibility.Public) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val nameFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { nameFocus.requestFocus() } }
    fun create() {
        if (busy) return
        if (textLength(name.trim()) > Limits.ROOM_NAME) {
            error = "Must be no more than ${Limits.ROOM_NAME} characters."
            return
        }
        busy = true
        error = ""
        scope.launch {
            runCatching { services.actions.create(name, visibility) }
                .onSuccess(onCreated)
                .onFailure { e -> error = if (e is ApiError && e.codes["name"] == "validation_not_unique") "A room with this name already exists." else (e as? ApiError)?.fields?.get("name") ?: errorMessage(e) }
            busy = false
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New room") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    name,
                    { name = it },
                    label = { Text("Room name") },
                    placeholder = { Text("room-name") },
                    singleLine = true,
                    isError = error.isNotEmpty(),
                    supportingText = if (error.isNotEmpty()) ({ Text(error) }) else null,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { if (name.isNotBlank()) create() }),
                    modifier = Modifier.fillMaxWidth().focusRequester(nameFocus),
                )
                Text("Who can see it", style = MaterialTheme.typography.titleSmall)
                for (v in listOf(Visibility.Public, Visibility.Private, Visibility.Open)) {
                    Row(
                        Modifier.fillMaxWidth().selectable(visibility == v, role = Role.RadioButton) { visibility = v }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(visibility == v, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(v.label)
                            Text(v.hint, style = MaterialTheme.typography.bodySmall, color = Chat.colors.muted)
                        }
                    }
                }
            }
        },
        confirmButton = { Button(onClick = ::create, enabled = !busy && name.isNotBlank()) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
