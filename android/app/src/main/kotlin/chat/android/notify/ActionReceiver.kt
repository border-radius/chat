package chat.android.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import chat.android.ChatApp
import chat.android.data.lib.newId
import chat.android.data.lib.toPb
import chat.android.data.model.Message
import chat.android.data.model.MessageExpand
import chat.android.data.model.SendStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** A notification's Reply (sent through the outbox, §9.2) and Mark as read (ANDROID.md §8.3). */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val room = intent.getStringExtra("room") ?: return
        val account = intent.getStringExtra("account").orEmpty()
        val created = intent.getStringExtra("created").orEmpty()
        val pending = goAsync()
        scope.launch {
            try {
                val services = ChatApp.of(context).servicesFor(account) ?: return@launch Notifications.cancel(context, account, room)
                val me = services.api.currentUser() ?: return@launch Notifications.cancel(context, account, room)
                when (intent.action) {
                    REPLY -> {
                        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifications.KEY_REPLY)?.toString()?.trim().orEmpty()
                        if (text.isEmpty()) return@launch
                        val now = toPb(System.currentTimeMillis())
                        services.outbox.enqueue(me.id, Message(newId(), room, me.id, text, now, now, expand = MessageExpand(author = me), status = SendStatus.Pending))
                        Notifications.addOwnReply(context, account, room, text)
                        // Replying reads the conversation up to what was answered.
                        if (created.isNotEmpty()) runCatching { services.api.markRead(room, created) }
                    }
                    READ -> {
                        if (created.isNotEmpty()) runCatching { services.api.markRead(room, created) }
                        Notifications.cancel(context, account, room)
                    }
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val REPLY = "chat.android.REPLY"
        const val READ = "chat.android.READ"
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    }
}
