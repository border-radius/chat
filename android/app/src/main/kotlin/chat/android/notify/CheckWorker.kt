// Notifications without Google (ANDROID.md §8): a periodic WorkManager job, about every 15 minutes (Android's
// shortest period; Doze may stretch it) while the network is up, checks every signed-in account for DMs and replies
// to you (core:data's NotifyCheck) and notifies of them. No Firebase, no push service, no connection kept open.
package chat.android.notify

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import chat.android.ChatApp
import chat.android.data.api.toApiError
import chat.android.data.lib.serverLabel
import chat.android.data.repo.Accounts
import chat.android.data.repo.ChatServices
import java.util.concurrent.TimeUnit

class CheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = when (checkAll(applicationContext, ChatApp.of(applicationContext).accounts)) {
        Outcome.Done -> Result.success()
        Outcome.Offline -> Result.retry()
        Outcome.NoOne -> {
            cancel(applicationContext)
            Result.success()
        }
    }

    enum class Outcome { Done, Offline, NoOne }

    companion object {
        private const val NAME = "notify-check"

        /** Someone is signed in: check in the background (kept as it is when already scheduled). */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        /** Check every account signed in, and notify of what is new. */
        suspend fun checkAll(context: Context, accounts: Accounts): Outcome {
            accounts.load()
            val signedIn = accounts.list.value.filter { it.user != null }
            if (signedIn.isEmpty()) return Outcome.NoOne
            var offline = false
            for (a in signedIn) {
                val services = accounts.services(a.id) ?: continue
                try {
                    check(context, accounts, services, many = signedIn.size > 1)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Offline: tried again soon. Refused or broken: the next period (a refused session is the app's to end).
                    if (e.toApiError().status == 0) offline = true
                }
            }
            return if (offline) Outcome.Offline else Outcome.Done
        }

        private suspend fun check(context: Context, accounts: Accounts, services: ChatServices, many: Boolean) {
            services.notifyCheck.forgetPushToken()
            val s = services.store.get()
            // On screen with this account: the room list shows what is new.
            val onScreen = accounts.active.value === services && !s.away
            val result = services.notifyCheck.run(quiet = onScreen, openRoom = s.activeRoomId.takeIf { !s.away }) ?: return
            Notifications.clearRead(context, services.accountId, result.unreadRooms)
            if (result.notices.isEmpty()) return
            val me = services.api.currentUser() ?: return
            val label = if (many) "${me.name} · ${serverLabel(services.server)}" else null
            for (n in result.notices) {
                n.messages.forEachIndexed { i, m ->
                    Notifications.show(context, services, n.room, m, n.unread, account = label, alert = i == 0)
                }
                // The room opens at once from it (§6.3).
                runCatching { services.prefetch.fetch(me.id, n.room.id) }
            }
        }

        /** No one is signed in any more. */
        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
