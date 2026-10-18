package chat.android.push

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import chat.android.ChatApp
import chat.android.data.api.ApiError
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** FCM's entry point: a push carries ids only (room, message); a job fetches the message, then notifies (§8.3). */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val room = message.data["room"] ?: return
        val msg = message.data["message"] ?: return
        PushWorker.enqueue(this, room, msg, message.data["user"].orEmpty())
    }

    override fun onNewToken(token: String) {
        scope.launch { Push.onNewToken(this@PushService, ChatApp.of(this@PushService)) }
    }

    private companion object {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    }
}

class PushWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val roomId = inputData.getString("room") ?: return Result.success()
        val msgId = inputData.getString("message") ?: return Result.success()
        val app = ChatApp.of(applicationContext)
        // The account the push is for (§17.4); a server too old to say goes to the active one.
        val user = inputData.getString("user").orEmpty()
        val services = (if (user.isEmpty()) app.servicesFor(null) else app.accounts.forUser(user)) ?: return Result.success()
        val me = services.api.currentUser() ?: return Result.success()
        val s = services.store.get()
        // The open room, seen right now, needs no notification.
        if (s.activeRoomId == roomId && !s.away) return Result.success()
        val m = try {
            services.api.getMessage(msgId)
        } catch (e: ApiError) {
            return if (e.status == 0) Result.retry() else Result.success() // gone, or not yours to see
        }
        if (m.author == me.id || m.deleted) return Result.success()
        val room = s.rooms[roomId] ?: runCatching { services.api.getRoom(roomId) }.getOrNull() ?: return Result.success()
        // Hidden and archived rooms stay silent (DESIGN.md §13).
        if (room.archived || roomId in s.hidden || runCatching { services.api.listHidden().any { it.room == roomId } }.getOrDefault(false)) return Result.success()
        val unread = runCatching { services.api.unreadCounts().rooms[roomId] }.getOrNull() ?: 1
        if (unread == 0) return Result.success() // read meanwhile, elsewhere
        val many = app.accounts.list.value.count { it.user != null } > 1
        Notifications.show(applicationContext, services, room, m, unread, account = if (many) "${me.name} · ${chat.android.data.lib.serverLabel(services.server)}" else null)
        // The room opens at once with it (§6.3).
        services.prefetch.fetch(me.id, roomId)
        return Result.success()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val n = Notifications.sending(applicationContext, "Checking for new messages…")
        return if (android.os.Build.VERSION.SDK_INT >= 29) ForegroundInfo(7002, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(7002, n)
    }

    companion object {
        fun enqueue(context: Context, room: String, message: String, user: String) {
            val request = OneTimeWorkRequestBuilder<PushWorker>()
                .setInputData(workDataOf("room" to room, "message" to message, "user" to user))
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context).enqueue(request)
        }
    }
}
