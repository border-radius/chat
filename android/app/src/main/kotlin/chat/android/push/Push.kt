// Push registration (ANDROID.md §8.1): after the first frame of a session the device's token goes to push_tokens; on
// log out its row is deleted. FCM only when the build has a Firebase project (chat.fcm.* Gradle properties); the
// server then sends ids only, and the app fetches the message with its own session (§8.2).
package chat.android.push

import android.content.Context
import chat.android.BuildConfig
import chat.android.data.db.Keys
import chat.android.data.db.KvEntity
import chat.android.data.repo.ChatServices
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

object Push {
    val enabled: Boolean get() = BuildConfig.FCM_PROJECT_ID.isNotEmpty()

    /** Firebase, set up by hand: no google-services plugin, no ContentProvider at launch (§11). */
    fun firebase(context: Context): FirebaseApp? {
        if (!enabled) return null
        FirebaseApp.getApps(context).firstOrNull()?.let { return it }
        val options = FirebaseOptions.Builder()
            .setProjectId(BuildConfig.FCM_PROJECT_ID)
            .setApplicationId(BuildConfig.FCM_APP_ID)
            .setApiKey(BuildConfig.FCM_API_KEY)
            .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
            .build()
        return FirebaseApp.initializeApp(context, options)
    }

    private suspend fun fcmToken(context: Context): String? {
        firebase(context) ?: return null
        return suspendCancellableCoroutine { cont ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t -> cont.resume(if (t.isSuccessful) t.result else null) }
        }
    }

    /** Register this device for the session's pushes. A token already registered is kept. */
    suspend fun register(context: Context, services: ChatServices) {
        val token = fcmToken(context) ?: return
        val saved = services.db.kv().get(Keys.PUSH_ROW)?.split(' ', limit = 2)
        if (saved?.getOrNull(1) == token) return
        saved?.getOrNull(0)?.let { runCatching { services.api.unregisterPush(it) } }
        val row = runCatching { services.api.registerPush(token, "fcm") }.getOrNull() ?: return
        services.db.kv().put(KvEntity(Keys.PUSH_ROW, "$row $token"))
    }

    /** A new token (FCM rotated it): registered again, by every account signed in (ANDROID.md §17.4). */
    suspend fun onNewToken(context: Context, app: chat.android.ChatApp) {
        app.accounts.load()
        for (a in app.accounts.list.value) {
            if (a.user == null) continue
            app.servicesFor(a.id)?.let { runCatching { register(context, it) } }
        }
    }

    /**
     * Before log out, while the session is still valid: the server stops pushing to this device for this account.
     * [deleteToken]: no other account uses the device's token (§17.4).
     */
    suspend fun unregister(context: Context, services: ChatServices, deleteToken: Boolean) {
        val row = services.db.kv().get(Keys.PUSH_ROW)?.substringBefore(' ') ?: return
        runCatching { services.api.unregisterPush(row) }
        services.db.kv().delete(Keys.PUSH_ROW)
        if (enabled && deleteToken) runCatching { firebase(context); FirebaseMessaging.getInstance().deleteToken() }
    }
}
