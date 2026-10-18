// The one activity (ANDROID.md §7): the navigation, links to rooms and messages (App Links, §9.4; notifications), shares
// (§9.3), the notification permission, and FLAG_SECURE when the user asked for it (§10).
package chat.android

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import chat.android.nav.AppRoot
import chat.android.nav.Linked
import chat.android.push.Notifications
import chat.android.nav.Room
import chat.android.nav.ShareInbox
import chat.android.nav.routeOf
import chat.android.ui.ChatTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    /** A room the last intent asked for (a link, a notification), in its account. */
    private var linked by mutableStateOf<Linked?>(null)
    private var ready by mutableStateOf(false)
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val app = ChatApp.of(this)
        app.start()
        if (savedInstanceState == null) take(intent)
        lifecycleScope.launch {
            app.ready.await()
            ready = true
            app.accounts.settings.secureScreens.collect { secure ->
                if (secure) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
        setContent {
            ChatTheme {
                // Nothing but the theme's background until the stored session is read (a few ms).
                if (ready) AppRoot(app.accounts, linked = linked, onLinkTaken = { linked = null }, onSignedIn = ::askForNotifications)
                LaunchedEffect(Unit) { reportFullyDrawnWhenReady(app) }
            }
        }
    }

    private suspend fun reportFullyDrawnWhenReady(app: ChatApp) {
        app.ready.await()
        reportFullyDrawn()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    private fun take(intent: Intent?) {
        intent ?: return
        ShareInbox.read(intent)?.let { ShareInbox.pending = it; return }
        val app = ChatApp.of(this)
        if (intent.action == Notifications.OPEN) {
            val account = intent.getStringExtra("account") ?: return
            val room = intent.getStringExtra("room") ?: return
            return open(account, Room(room, intent.getStringExtra("msg")))
        }
        val url = intent.data?.toString() ?: return
        lifecycleScope.launch {
            app.ready.await()
            // The account on the link's server (ANDROID.md §17.3).
            val (account, path) = app.accounts.forLink(url) ?: return@launch
            routeOf(path)?.let { open(account, it) }
        }
    }

    /** Show [room] in [account], switching to it. */
    private fun open(account: String, room: Room) {
        val app = ChatApp.of(this)
        lifecycleScope.launch {
            app.ready.await()
            app.accounts.switchTo(account)
            if (app.accounts.active.value?.accountId == account) linked = Linked(account, room)
        }
    }

    /** Pushes need the permission on Android 13+: asked once someone is signed in (not at first launch). */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
