package chat.android

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import chat.android.data.repo.DrainResult
import java.util.concurrent.TimeUnit

/** Sends the outbox when the process may die before it is done (ANDROID.md §9.2): with a network, expedited. */
class OutboxWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val services = ChatApp.of(applicationContext).servicesFor(inputData.getString(ACCOUNT)) ?: return Result.success()
        return when (services.outbox.drain()) {
            DrainResult.Done -> Result.success()
            DrainResult.Retry -> Result.retry()
        }
    }

    /** Expedited work before Android 12 runs as a foreground service: it says what it is doing (§9.2). */
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val n = chat.android.push.Notifications.sending(applicationContext)
        return if (android.os.Build.VERSION.SDK_INT >= 29) ForegroundInfo(SENDING_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(SENDING_ID, n)
    }

    companion object {
        private const val SENDING_ID = 7001
        private const val ACCOUNT = "account"

        /** Each account's outbox drains in work of its own (ANDROID.md §17.1). */
        fun name(account: String) = "outbox-$account"

        fun schedule(context: Context, account: String) {
            val request = OneTimeWorkRequestBuilder<OutboxWorker>()
                .setInputData(androidx.work.workDataOf(ACCOUNT to account))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            // After a drain already running: what it picked up is sent, then this one picks up the rest.
            WorkManager.getInstance(context).enqueueUniqueWork(name(account), ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }
    }
}
