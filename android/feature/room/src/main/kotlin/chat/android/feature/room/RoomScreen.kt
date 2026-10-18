// A room or DM (ANDROID.md §7, §7.1; web/src/views/room.ts): the message list laid out from the bottom, the composer
// or why you can't post, search (§29), selecting messages to forward or delete (§21), and the room's menu.
package chat.android.feature.room

import android.app.DownloadManager
import android.content.ClipData
import android.content.Context
import android.net.Uri
import android.os.Environment
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import chat.android.data.lib.PageKind
import chat.android.data.lib.Side
import chat.android.data.lib.attachmentName
import chat.android.data.lib.canPost
import chat.android.data.lib.highlight
import chat.android.data.lib.label
import chat.android.data.lib.title
import chat.android.data.lib.visibilityOrDefault
import chat.android.data.model.Message
import chat.android.data.model.Visibility
import chat.android.data.repo.Phase
import chat.android.data.repo.Pill
import chat.android.data.repo.Scroll
import chat.android.ui.Chat
import chat.android.ui.ChatIcons
import chat.android.ui.Formats
import chat.android.ui.LocalServices
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Where the room screen sends you. */
class RoomNav(
    val back: () -> Unit,
    val openRoom: (String) -> Unit,
    val access: (String) -> Unit,
    val viewer: (roomId: String, msgId: String, file: String) -> Unit,
    val logIn: () -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomScreen(roomId: String, msgId: String?, nav: RoomNav, incoming: Pair<String, List<Uri>>? = null, onIncomingTaken: () -> Unit = {}) {
    val services = LocalServices.current
    val context = LocalContext.current
    val app = context.applicationContext as android.app.Application
    val vm: RoomViewModel = viewModel(key = "room-$roomId-$msgId") { RoomViewModel(app, services, roomId, msgId) }
    val c = vm.controller
    val state by c.state.collectAsStateWithLifecycle()
    val rows by vm.rows.collectAsStateWithLifecycle()
    val app_ by services.store.flow.collectAsStateWithLifecycle()
    val progress by c.progress.collectAsStateWithLifecycle()
    val recent by services.recentEmoji.list.collectAsStateWithLifecycle()
    val room = app_.rooms[roomId]
    val me = app_.user
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val focus = remember { FocusRequester() }
    val clipboard = LocalClipboard.current
    var sheetFor by remember { mutableStateOf<Message?>(null) }
    var emojiFor by remember { mutableStateOf<Message?>(null) }
    var composerEmoji by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<List<String>?>(null) }
    var forwarding by remember { mutableStateOf<List<String>?>(null) }
    var roomMenu by remember { mutableStateOf(false) }

    val atBottom by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 64 } }
    LaunchedEffect(atBottom, rows) { vm.onAtBottom(atBottom) }
    // Shared into the app (§9.3): into the composer, as if typed and attached here.
    LaunchedEffect(incoming) {
        val (text, uris) = incoming ?: return@LaunchedEffect
        if (text.isNotBlank()) vm.onText(androidx.compose.ui.text.input.TextFieldValue(text, androidx.compose.ui.text.TextRange(text.length)))
        if (uris.isNotEmpty()) vm.attach(uris)
        onIncomingTaken()
    }
    LaunchedEffect(vm.toast) { vm.toast?.let { snackbar.showSnackbar(it); vm.toast = null } }

    // The list nears an end: extend the window there.
    LaunchedEffect(list) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index to list.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) -> if (last != null && total > 0 && last >= total - 10) c.loadEdge(Side.Top) }
    }
    LaunchedEffect(list) {
        snapshotFlow { list.firstVisibleItemIndex }.distinctUntilChanged().collect { if (it < 10 && c.state.value.hasNewer) c.loadEdge(Side.Bottom) }
    }
    // What the controller asks of the list after a change. One scroll that fails (the list changed under it) must not
    // end the scrolling for good.
    LaunchedEffect(c) {
        c.scrolls.collect { s ->
            runCatching {
                when (s) {
                    Scroll.Bottom -> list.scrollToItem(0)
                    Scroll.Top -> withTimeoutOrNull(1000) { vm.rows.first { it.isNotEmpty() } }?.let { list.scrollToItem(it.lastIndex) }
                    Scroll.Target -> {
                        val key = c.state.value.targetId ?: c.state.value.unreadId ?: return@runCatching
                        val rowsNow = withTimeoutOrNull(1000) { vm.rows.first { r -> r.any { it.key == key } } } ?: return@runCatching
                        // The list is laid out from the bottom: two rows newer than the target at the bottom puts it a
                        // little above the composer, with what follows it in view.
                        list.scrollToItem(maxOf(0, rowsNow.indexOfFirst { it.key == key } - 2))
                    }
                    Scroll.Anchor -> {}
                }
            }
        }
    }

    val names = remember(state.items, room) {
        val map = HashMap<String, String>()
        room?.expand?.members?.forEach { map[it.id] = it.name }
        for (m in state.items) m.expand?.author?.let { map[it.id] = it.name }
        map
    }
    val actions = RowActions(
        onLongPress = { m -> if (vm.selecting) vm.toggleSelect(m) else if (m.status == null && !m.isService) sheetFor = m },
        onTap = { m -> if (vm.selecting) vm.toggleSelect(m) },
        onQuote = { id -> c.goTo(id) },
        onReact = { m, e -> vm.react(m, e) },
        onRetry = { c.retrySend(it.id) },
        onDiscard = { c.discard(it.id) },
        onOpenMedia = { m, f -> nav.viewer(roomId, m.id, f) },
        onFile = { m, f -> scope.launch { download(context, services, m, f) } },
        reactions = { c.reactions(it) },
        name = { names[it] },
        progress = { progress[it] },
    )

    Scaffold(
        topBar = {
            when {
                vm.selecting -> TopAppBar(
                    navigationIcon = { IconButton(onClick = vm::clearSelection) { Icon(ChatIcons.Close, contentDescription = "Cancel") } },
                    title = { Text("${vm.selected.size} selected", modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) },
                    actions = {
                        if (me != null) IconButton(onClick = { forwarding = vm.selected.toList() }) { Icon(ChatIcons.Forward, contentDescription = "Forward") }
                        if (vm.canDeleteSelected) IconButton(onClick = { confirmDelete = vm.selected.toList() }) { Icon(ChatIcons.Delete, contentDescription = "Delete") }
                    },
                )
                vm.searching -> TopAppBar(
                    navigationIcon = { IconButton(onClick = vm::closeSearch) { Icon(ChatIcons.Back, contentDescription = "Close search") } },
                    title = {
                        val searchFocus = remember { FocusRequester() }
                        LaunchedEffect(Unit) { searchFocus.requestFocus() }
                        TextField(
                            vm.query,
                            vm::onQuery,
                            placeholder = { Text("Search ${room?.title(me?.id) ?: ""}", maxLines = 1) },
                            singleLine = true,
                            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { vm.searchNow() }),
                            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
                            colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent),
                            modifier = Modifier.fillMaxWidth().focusRequester(searchFocus).semantics { contentDescription = "Search messages" },
                        )
                    },
                )
                else -> TopAppBar(
                    navigationIcon = { IconButton(onClick = nav.back) { Icon(ChatIcons.Back, contentDescription = "Back to rooms") } },
                    title = {
                        Column(Modifier.clickable(enabled = room != null && !room.isDm) { nav.access(roomId) }) {
                            Text(room?.title(me?.id) ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Bold)
                            if (room != null && !room.isDm) {
                                Text(
                                    room.visibilityOrDefault.label + if (room.visibilityOrDefault == Visibility.Private) " · ${room.members.size} ${if (room.members.size == 1) "member" else "members"}" else "",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = Chat.colors.muted,
                                )
                            }
                        }
                    },
                    actions = {
                        if (room != null) IconButton(onClick = vm::openSearch) { Icon(ChatIcons.Search, contentDescription = "Search messages") }
                        if (room != null && me != null) {
                            Box {
                                IconButton(onClick = { roomMenu = true }) { Icon(ChatIcons.More, contentDescription = "Room actions") }
                                RoomMenu(roomMenu, { roomMenu = false }, room, me.id, app_.hidden.containsKey(roomId), nav, snackbar)
                            }
                        }
                    },
                )
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Box(Modifier.navigationBarsPadding().imePadding()) {
                when {
                    room == null || state.phase == Phase.NotFound -> {}
                    me == null -> ReadOnly("You're reading as a guest. ", "Log in", nav.logIn)
                    room.archived -> ReadOnly("This room is archived. History is read-only.")
                    !room.canPost(me.id) -> ReadOnly("Only some people can post in this room. You can read along and react.")
                    vm.selecting -> {}
                    else -> Composer(vm, "Message ${room.title(me.id)}", focus) { composerEmoji = true }
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (state.phase) {
                Phase.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                Phase.NotFound -> Centered(if (room == null && app_.rooms.isNotEmpty()) "You can't see this room any more." else "This room doesn't exist.")
                Phase.Failed -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Couldn't load this room. Check your connection. ")
                    TextButton(onClick = c::retry) { Text("Retry") }
                }
                Phase.Ready -> {
                    LazyColumn(state = list, reverseLayout = true, modifier = Modifier.fillMaxSize().semantics { contentDescription = "Messages" }) {
                        items(rows, key = { it.key }, contentType = { it::class }) { row ->
                            when (row) {
                                is ListRow.Msg -> MessageRow(row.m, row.first, row.target, me?.id, vm.selecting, row.m.id in vm.selected, actions)
                                is ListRow.Day -> DayHeader(row.label)
                                ListRow.NewLine -> NewLine()
                                is ListRow.Beginning -> Text(row.text, color = Chat.colors.muted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(24.dp))
                            }
                        }
                    }
                    if (state.notice.isNotEmpty()) {
                        Surface(Modifier.align(Alignment.TopCenter).padding(8.dp), tonalElevation = 4.dp, shape = MaterialTheme.shapes.medium) {
                            Text(state.notice, modifier = Modifier.padding(12.dp).semantics { liveRegion = LiveRegionMode.Polite })
                        }
                    }
                    if (state.pill != null || !atBottom || state.hasNewer) {
                        val label = if (state.pill != null) "New messages · Jump to latest" else "Jump to latest"
                        SmallFloatingActionButton(
                            onClick = {
                                if (state.hasNewer) c.jump(PageKind.Latest) else scope.launch { list.animateScrollToItem(0) }
                                c.dismissPill()
                            },
                            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp).semantics { contentDescription = label },
                        ) {
                            Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (state.pill != null) Text("New", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(end = 4.dp))
                                Icon(ChatIcons.Down, contentDescription = null)
                            }
                        }
                    }
                }
            }
            if (vm.searching) SearchResults(vm) { vm.pick(it) }
        }
    }

    sheetFor?.let { m ->
        val items = buildList {
            if (c.repliable(m)) add(MenuItem("Reply", ChatIcons.Reply) { sheetFor = null; vm.reply(m); focus.requestFocusSafely() })
            if (c.editable(m)) add(MenuItem("Edit", ChatIcons.Edit) { sheetFor = null; vm.startEdit(m); focus.requestFocusSafely() })
            if (m.text.isNotEmpty() && !m.deleted) add(MenuItem("Copy text", ChatIcons.Copy) {
                sheetFor = null
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("message", m.text))) }
            })
            if (me != null && c.selectable(m)) add(MenuItem("Forward", ChatIcons.Forward) { sheetFor = null; forwarding = listOf(m.id) })
            if (c.selectable(m)) add(MenuItem("Select", ChatIcons.Check) { sheetFor = null; vm.toggleSelect(m) })
            if (c.deletable(m)) add(MenuItem("Delete", ChatIcons.Delete) { sheetFor = null; confirmDelete = listOf(m.id) })
        }
        MessageSheet(m, c.reactable(m), recent, items, onReact = { e -> sheetFor = null; vm.react(m, e) }, onMoreEmoji = { sheetFor = null; emojiFor = m }, onDismiss = { sheetFor = null })
    }
    emojiFor?.let { m -> EmojiSheet("Add reaction", recent, onPick = { e -> emojiFor = null; vm.react(m, e) }, onDismiss = { emojiFor = null }) }
    if (composerEmoji) EmojiSheet("Insert emoji", recent, onPick = { e -> composerEmoji = false; vm.insert(e); services.recentEmoji.remember(e) }, onDismiss = { composerEmoji = false })
    confirmDelete?.let { ids ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(if (ids.size == 1) "Delete message" else "Delete these messages?") },
            text = { Text(if (ids.size == 1) "Delete this message? Everyone will see that it was deleted." else "Delete these ${ids.size} messages? Everyone will see that they were deleted.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = null
                    if (ids.size == 1 && !vm.selecting) c.find(ids[0])?.let(vm::delete) else vm.deleteSelected()
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
    forwarding?.let { ids ->
        ForwardSheet(ids.size, forwardTargets(app_), me?.id, onPick = { r -> forwarding = null; vm.forward(ids, r.id) {} }, onDismiss = { forwarding = null })
    }
}

private fun FocusRequester.requestFocusSafely() {
    runCatching { requestFocus() }
}

@Composable
private fun RoomMenu(open: Boolean, close: () -> Unit, room: chat.android.data.model.Room, me: String, hidden: Boolean, nav: RoomNav, snackbar: SnackbarHostState) {
    val services = LocalServices.current
    val scope = rememberCoroutineScope()
    var archive by remember { mutableStateOf(false) }
    fun act(label: String, block: suspend () -> Unit) {
        close()
        scope.launch { runCatching { block() }.onFailure { snackbar.showSnackbar("That didn't work. ${chat.android.data.api.errorMessage(it)}") } }
    }
    DropdownMenu(open, onDismissRequest = close) {
        if (!room.isDm) DropdownMenuItem(text = { Text(if (room.createdBy == me) "Room access…" else "Members") }, onClick = { close(); nav.access(room.id) })
        if (room.isDm) DropdownMenuItem(text = { Text("Close conversation") }, onClick = { act("close") { services.actions.hide(room.id); nav.back() } })
        else if (hidden) DropdownMenuItem(text = { Text("Unhide room") }, onClick = { act("unhide") { services.actions.unhide(room.id) } })
        else DropdownMenuItem(text = { Text("Hide room") }, onClick = { act("hide") { services.actions.hide(room.id); nav.back() } })
        if (!room.isDm && room.createdBy == me) {
            if (room.archived) DropdownMenuItem(text = { Text("Unarchive room") }, onClick = { act("unarchive") { services.actions.setArchived(room.id, false) } })
            else DropdownMenuItem(text = { Text("Archive room") }, onClick = { close(); archive = true })
        }
    }
    if (archive) {
        AlertDialog(
            onDismissRequest = { archive = false },
            title = { Text("Archive room") },
            text = { Text("Archive “${room.name}”? It becomes read-only for everyone.") },
            confirmButton = { TextButton(onClick = { archive = false; act("archive") { services.actions.setArchived(room.id, true) } }) { Text("Archive") } },
            dismissButton = { TextButton(onClick = { archive = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ReadOnly(text: String, action: String? = null, onAction: () -> Unit = {}) {
    Surface(tonalElevation = 2.dp) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, color = Chat.colors.muted, modifier = Modifier.weight(1f))
            if (action != null) Button(onClick = onAction) { Text(action) }
        }
    }
}

@Composable
private fun Centered(text: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) { Text(text, textAlign = TextAlign.Center) }
}

@Composable
private fun DayHeader(label: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = Chat.colors.border)
        Text(label, style = MaterialTheme.typography.labelMedium, color = Chat.colors.muted, modifier = Modifier.padding(horizontal = 8.dp).semantics { heading() })
        HorizontalDivider(Modifier.weight(1f), color = Chat.colors.border)
    }
}

@Composable
private fun NewLine() {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.secondary)
        Text("New", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.padding(horizontal = 8.dp))
    }
}

@Composable
private fun SearchResults(vm: RoomViewModel, onPick: (Message) -> Unit) {
    if (vm.query.isBlank() && vm.results.isEmpty()) return
    Surface(Modifier.fillMaxWidth().fillMaxHeightFraction(), tonalElevation = 3.dp) {
        LazyColumn(Modifier.semantics { contentDescription = "Search results" }) {
            item { Text(vm.searchStatus, color = Chat.colors.muted, modifier = Modifier.padding(16.dp).semantics { liveRegion = LiveRegionMode.Polite }) }
            items(vm.results, key = { it.id }) { m ->
                val accent = MaterialTheme.colorScheme.primary
                Column(Modifier.fillMaxWidth().clickable { onPick(m) }.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        m.expand?.author?.let { Text(it.name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium) }
                        Text(Formats.time(m.created), color = Chat.colors.muted, style = MaterialTheme.typography.labelSmall)
                    }
                    val parts = highlight(m.text, vm.searchWordsShown)
                    Text(
                        androidx.compose.ui.text.buildAnnotatedString {
                            parts.forEachIndexed { i, s ->
                                if (i % 2 == 1) pushStyle(androidx.compose.ui.text.SpanStyle(background = Chat.colors.highlight, fontWeight = FontWeight.Bold))
                                append(s)
                                if (i % 2 == 1) pop()
                            }
                        },
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (vm.moreResults) item { TextButton(onClick = vm::searchMore, modifier = Modifier.padding(8.dp)) { Text("Show older results") } }
        }
    }
}

private fun Modifier.fillMaxHeightFraction() = this.then(Modifier.height(420.dp))

/** Download an attachment with the system's download manager (a fresh file token in its URL, §17.3). */
private suspend fun download(context: Context, services: chat.android.data.repo.ChatServices, m: Message, file: String) {
    val token = runCatching { services.tokens.ensure() }.getOrDefault("")
    val url = services.api.fileUrl(m, file, token = token).toString()
    val name = m.attachmentName(file)
    val req = DownloadManager.Request(Uri.parse(url))
        .setTitle(name)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name.replace('/', '_'))
    runCatching { (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req) }
}
