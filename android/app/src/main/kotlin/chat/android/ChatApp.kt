// The process: builds the accounts on first use (ANDROID.md §5, §11: nothing at start but the first screen), starts
// the active one when the app first comes to the foreground, and tells it when it is visible (§9.1). Background work
// (a push, a notification's action, the outbox) gets its account's services without starting any (§17.1).
package chat.android

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import chat.android.data.repo.Accounts
import chat.android.data.repo.ChatServices
import chat.android.push.Notifications
import chat.android.push.Push
import chat.android.ui.Images
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Cache
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

class ChatApp : Application(), SingletonImageLoader.Factory, Configuration.Provider {
    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.MINUTES) // uploads of 10 files of 20 MB (§17.1)
            .dispatcher(okhttp3.Dispatcher().apply { maxRequestsPerHost = 8 })
            .cache(Cache(File(cacheDir, "http"), 10L * 1024 * 1024))
            .build()
    }

    /** Every account, and the active one's services: what the screens use. */
    val accounts: Accounts by lazy {
        Accounts(AppAccountEnv(this), http, Dispatchers.Main.immediate, BuildConfig.SERVER, allowHttp = BuildConfig.DEBUG)
    }

    /** The accounts are read and the active one started: the first screen can show. */
    val ready = CompletableDeferred<Unit>()
    private var started = false

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                start()
                accounts.setVisible(true)
            }

            override fun onStop(owner: LifecycleOwner) {
                accounts.setVisible(false)
            }
        })
    }

    /** Start the active account, once. */
    fun start() {
        if (started) return
        started = true
        accounts.scope.launch {
            accounts.start()
            ready.complete(Unit)
            // After the first frame of a session: notifications follow what is read (ANDROID.md §8.3).
            accounts.active.collectLatest { s -> if (s != null) Notifications.follow(this@ChatApp, s) }
        }
    }

    /** For a push or a notification action in a process without a screen: account [id]'s services, not started. */
    suspend fun servicesFor(id: String?): ChatServices? {
        if (id.isNullOrEmpty()) {
            accounts.load()
            return accounts.active.value ?: accounts.list.value.firstOrNull { it.user != null }?.let { accounts.services(it.id) }
        }
        return accounts.services(id)
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader = Images.loader(this, http)

    // WorkManager starts on demand, not from a ContentProvider at launch (§11).
    override val workManagerConfiguration: Configuration get() = Configuration.Builder().build()

    companion object {
        fun of(context: android.content.Context) = context.applicationContext as ChatApp
    }
}

/** What account [id]'s session needs from the app (core:data's SessionHooks). */
class AppHooks(private val app: ChatApp, private val id: String) : chat.android.data.repo.SessionHooks {
    override suspend fun onSignedIn(user: chat.android.data.model.User) {
        app.servicesFor(id)?.let { Push.register(app, it) }
    }

    override suspend fun beforeSignOut() {
        // The device's token itself goes only with the last account signed in on it (§17.4).
        val others = app.accounts.list.value.count { it.user != null && it.id != id }
        app.servicesFor(id)?.let { Push.unregister(app, it, deleteToken = others == 0) }
    }

    override suspend fun onSignedOut() {
        Notifications.cancelAccount(app, id)
        androidx.work.WorkManager.getInstance(app).cancelUniqueWork(OutboxWorker.name(id))
        SingletonImageLoader.get(app).let {
            it.memoryCache?.clear()
            it.diskCache?.clear()
        }
        withContext(Dispatchers.IO) {
            runCatching { app.http.cache?.evictAll() }
            AppAccountEnv.outboxDir(app, id).deleteRecursively()
        }
    }

    override fun scheduleOutbox() = OutboxWorker.schedule(app, id)
}
