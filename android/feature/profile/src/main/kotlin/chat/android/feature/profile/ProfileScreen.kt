// Your profile (DESIGN.md §15, §22.1–2; web/src/views/profile.ts): picture, display name, password, log out, your
// accounts (ANDROID.md §17), and this device's setting for keeping messages out of screenshots (§10).
package chat.android.feature.profile

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chat.android.data.api.ApiError
import chat.android.data.api.errorMessage
import chat.android.data.lib.Limits
import chat.android.data.lib.textLength
import chat.android.data.pb.UploadFile
import chat.android.ui.Avatar
import chat.android.ui.Chat
import chat.android.ui.ChatIcons
import chat.android.ui.ImagePrep
import chat.android.ui.LocalAccounts
import chat.android.ui.LocalServices
import chat.android.data.lib.serverLabel
import androidx.compose.foundation.clickable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

/** Why a new password can't be used, or none (the server checks again). */
fun passwordProblem(current: String, next: String, confirm: String): Map<String, String> = when {
    current.isEmpty() -> mapOf("current" to "Enter your current password.")
    next.length < Limits.PASSWORD_MIN -> mapOf("next" to "Must be at least ${Limits.PASSWORD_MIN} characters.")
    next == current -> mapOf("next" to "That is your current password. Choose a new one.")
    confirm != next -> mapOf("confirm" to "The passwords don't match.")
    else -> emptyMap()
}

private fun fieldMessage(e: Throwable, field: String) = (e as? ApiError)?.fields?.get(field) ?: errorMessage(e)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(onAddAccount: () -> Unit, onBack: () -> Unit) {
    val services = LocalServices.current
    val accounts = LocalAccounts.current
    val all = accounts?.list?.collectAsStateWithLifecycle()?.value.orEmpty().filter { it.user != null }
    val context = LocalContext.current
    val s by services.store.flow.collectAsStateWithLifecycle()
    val secure by services.settings.secureScreens.collectAsStateWithLifecycle()
    val me = s.user ?: return
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var avatarError by remember { mutableStateOf("") }
    var name by remember(me.id) { mutableStateOf(me.name) }
    var nameStatus by remember { mutableStateOf("") }
    var nameError by remember { mutableStateOf(false) }
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var pwErrors by remember { mutableStateOf(emptyMap<String, String>()) }
    var pwStatus by remember { mutableStateOf("") }

    fun upload(uri: Uri?) {
        if (uri == null || busy) return
        avatarError = ""
        val type = context.contentResolver.getType(uri) ?: ""
        if (type !in Limits.AVATAR_TYPES) {
            avatarError = "Choose a JPEG, PNG, WebP or GIF image."
            return
        }
        busy = true
        scope.launch {
            val prepared = withContext(Dispatchers.IO) {
                val dir = File(context.cacheDir, "avatar").apply { deleteRecursively(); mkdirs() }
                val raw = File(dir, "avatar." + (type.substringAfter('/')))
                context.contentResolver.openInputStream(uri)?.use { i -> raw.outputStream().use { i.copyTo(it) } }
                ImagePrep.prepare(raw, raw.name, type, ImagePrep.AVATAR_EDGE) ?: Triple(raw, raw.name, type)
            }
            val (file, fname, ftype) = prepared
            if (file.length() > Limits.AVATAR_BYTES) {
                avatarError = "That image is too large (max ${Limits.AVATAR_BYTES / 1024 / 1024} MB)."
                busy = false
                return@launch
            }
            runCatching { services.api.setAvatar(UploadFile(fname, ftype, file.asRequestBody(ftype.toMediaTypeOrNull()))) }
                .onFailure { avatarError = fieldMessage(it, "avatar") }
            busy = false
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { upload(it) }

    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChatIcons.Back, contentDescription = "Back to rooms") } },
            title = { Text("Your profile") },
        )
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Section("Picture")
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Avatar(me, 96.dp)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !busy) { Text("Change picture") }
                        if (me.avatar.isNotEmpty()) OutlinedButton(onClick = {
                            busy = true
                            scope.launch {
                                runCatching { services.api.removeAvatar() }.onFailure { avatarError = fieldMessage(it, "avatar") }
                                busy = false
                            }
                        }, enabled = !busy) { Text("Remove") }
                    }
                }
                if (avatarError.isNotEmpty()) Text(avatarError, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                HorizontalDivider(color = Chat.colors.border)

                Section("Display name")
                OutlinedTextField(
                    name,
                    { name = it; nameStatus = ""; nameError = false },
                    label = { Text("Display name") },
                    singleLine = true,
                    isError = nameError,
                    supportingText = if (nameStatus.isNotEmpty()) ({ Text(nameStatus, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }) else null,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(onClick = {
                    val n = name.trim()
                    val problem = if (n.isEmpty()) "A display name can't be empty." else if (textLength(n) > Limits.USER_NAME) "Must be no more than ${Limits.USER_NAME} characters." else ""
                    nameError = problem.isNotEmpty()
                    nameStatus = problem
                    // Your own name back (after "taken", say): nothing to save, and nothing wrong (QA BUG-56).
                    if (problem.isNotEmpty() || n == me.name) return@Button
                    scope.launch {
                        runCatching { services.api.rename(n) }
                            .onSuccess { name = it.name; nameStatus = "Saved." }
                            .onFailure { nameStatus = fieldMessage(it, "name"); nameError = true }
                    }
                }) { Text("Save") }
                HorizontalDivider(color = Chat.colors.border)

                Section("Password")
                PasswordField("Current password", current, pwErrors["current"]) { current = it }
                PasswordField("New password", next, pwErrors["next"]) { next = it }
                PasswordField("Confirm new password", confirm, pwErrors["confirm"]) { confirm = it }
                if (pwStatus.isNotEmpty()) Text(pwStatus, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                Button(onClick = {
                    pwStatus = ""
                    pwErrors = passwordProblem(current, next, confirm)
                    if (pwErrors.isNotEmpty()) return@Button
                    scope.launch {
                        runCatching { services.api.changePassword(current, next) }
                            .onSuccess {
                                current = ""; next = ""; confirm = ""
                                pwStatus = "Password changed. You were logged out everywhere else."
                            }
                            .onFailure { e ->
                                val f = (e as? ApiError)?.fields.orEmpty()
                                if (f["oldPassword"] != null || f["password"] != null) {
                                    pwErrors = buildMap { f["oldPassword"]?.let { put("current", it) }; f["password"]?.let { put("next", it) } }
                                } else pwStatus = errorMessage(e)
                            }
                    }
                }) { Text("Change password") }
                HorizontalDivider(color = Chat.colors.border)

                Section("Accounts")
                for (a in all) {
                    val user = a.user ?: continue
                    val current = a.id == services.accountId
                    Row(
                        Modifier.fillMaxWidth()
                            .clickable(enabled = !current && accounts != null) { accounts?.scope?.launch { accounts.switchTo(a.id) } }
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Avatar(user, 36.dp, url = a.avatarUrl)
                        Column(Modifier.weight(1f)) {
                            Text(user.name)
                            Text(serverLabel(a.server), style = MaterialTheme.typography.bodySmall, color = Chat.colors.muted)
                        }
                        if (current) Text("In use", style = MaterialTheme.typography.bodySmall, color = Chat.colors.muted)
                    }
                }
                if (accounts != null) OutlinedButton(onClick = onAddAccount) { Text("Add account") }
                HorizontalDivider(color = Chat.colors.border)

                Section("This device")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Hide messages from screenshots")
                        Text("Screens with messages can't be captured, and are blank in recent apps.", style = MaterialTheme.typography.bodySmall, color = Chat.colors.muted)
                    }
                    Switch(secure, onCheckedChange = services.settings::setSecureScreens)
                }
                HorizontalDivider(color = Chat.colors.border)

                Section("Session")
                TextButton(onClick = { scope.launch { services.logOut() } }) { Text("Log out", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

@Composable
private fun Section(title: String) {
    Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
}

@Composable
private fun PasswordField(label: String, value: String, error: String?, onChange: (String) -> Unit) {
    OutlinedTextField(
        value,
        onChange,
        label = { Text(label) },
        singleLine = true,
        isError = error != null,
        supportingText = error?.let { { Text(it) } },
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth(),
    )
}
