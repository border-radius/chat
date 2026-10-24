// Finding people by name (§16.3, web/src/ui/user-search.ts): for a new DM, and for a room's members and writers. An
// address, "ann@b.example", finds someone on a linked instance (§33.5).
package chat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import chat.android.data.api.reasonOf
import chat.android.data.lib.isAddress
import chat.android.data.model.User
import kotlinx.coroutines.delay

/**
 * A dialog that finds people by name; [onPick] gets the one chosen. [exclude]: ids not to offer; [selected]: ids shown
 * checked. [remote]: an address is looked up on its instance; [room], to add them to that shared room (else for a DM).
 */
@Composable
fun UserSearchDialog(
    title: String,
    onPick: (User) -> Unit,
    onDismiss: () -> Unit,
    exclude: Set<String> = emptySet(),
    confirm: String? = null,
    selected: Set<String> = emptySet(),
    remote: Boolean = true,
    room: String? = null,
) {
    val services = LocalServices.current
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<User>?>(null) }
    var status by remember { mutableStateOf("Type a name.") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(query) {
        if (query.isBlank()) {
            found = null
            status = "Type a name."
            return@LaunchedEffect
        }
        delay(250)
        status = "Searching…"
        val q = query.trim()
        var refused = ""
        found = runCatching { if (remote && isAddress(q)) listOf(services.api.remoteUser(q, room)) else services.api.searchUsers(q) }
            .onFailure { if (remote && isAddress(q)) refused = reasonOf(it) }
            .getOrNull()?.filter { it.id !in exclude }
        status = when {
            refused.isNotEmpty() -> refused
            found == null -> "Couldn't search. Check your connection."
            found!!.isEmpty() -> "No one found."
            else -> ""
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(query, { query = it }, placeholder = { Text("Find someone…") }, singleLine = true, modifier = Modifier.fillMaxWidth().focusRequester(focus))
                if (status.isNotEmpty()) Text(status, color = Chat.colors.muted, style = MaterialTheme.typography.bodyMedium)
                LazyColumn(Modifier.heightIn(max = 320.dp)) {
                    items(found.orEmpty(), key = { it.id }) { u ->
                        Row(
                            Modifier.fillMaxWidth().clickable(enabled = !u.noDms || confirm != null) { onPick(u) }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Avatar(u, 32.dp)
                            Column(Modifier.weight(1f)) {
                                Text(u.name)
                                if (u.instance.isNotEmpty()) Text("On ${u.instance}", style = MaterialTheme.typography.bodySmall, color = Chat.colors.muted)
                                if (u.noDms && confirm == null) Text("Doesn't take direct messages", style = MaterialTheme.typography.bodySmall, color = Chat.colors.muted)
                            }
                            if (u.id in selected) Icon(ChatIcons.Check, contentDescription = "Added", tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(confirm ?: "Cancel") } },
    )
}
