// Where accounts live on the device (ANDROID.md §17.1): the index and each session encrypted in no-backup storage,
// a database per account, its outbox files under files/outbox/<id>.
package chat.android

import android.util.AtomicFile
import androidx.work.WorkManager
import chat.android.data.db.ChatDatabase
import chat.android.data.pb.AuthStore
import chat.android.data.pb.FileAuthStore
import chat.android.data.pb.KeystoreBox
import chat.android.data.pb.PbJson
import chat.android.data.repo.AccountEnv
import chat.android.data.repo.AccountIndex
import chat.android.data.repo.SessionHooks
import chat.android.push.Notifications
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

class AppAccountEnv(private val app: ChatApp) : AccountEnv {
    private val box = KeystoreBox()
    private val dir get() = File(app.noBackupFilesDir, "accounts").apply { mkdirs() }
    private val indexFile get() = AtomicFile(File(app.noBackupFilesDir, "accounts.bin"))
    private val stores = mutableMapOf<String, FileAuthStore>()
    private val dbs = mutableMapOf<String, ChatDatabase>()

    override suspend fun readIndex(): AccountIndex = withContext(Dispatchers.IO) {
        runCatching { PbJson.decodeFromString(AccountIndex.serializer(), String(box.open(indexFile.readFully()))) }.getOrDefault(AccountIndex())
    }

    override suspend fun writeIndex(index: AccountIndex) = withContext(Dispatchers.IO) {
        synchronized(this@AppAccountEnv) {
            val f = indexFile
            val out = f.startWrite()
            try {
                out.write(box.seal(PbJson.encodeToString(AccountIndex.serializer(), index).toByteArray()))
                f.finishWrite(out)
            } catch (e: Exception) {
                f.failWrite(out)
            }
        }
    }

    override suspend fun authStore(id: String): AuthStore {
        synchronized(stores) { stores[id] }?.let { return it }
        val store = FileAuthStore(File(dir, "$id.bin"), box)
        withContext(Dispatchers.IO) { store.load() }
        return synchronized(stores) { stores.getOrPut(id) { store } }
    }

    override fun database(id: String): ChatDatabase = synchronized(dbs) { dbs.getOrPut(id) { ChatDatabase.open(app, dbName(id)) } }

    override fun hooks(id: String): SessionHooks = AppHooks(app, id)

    override suspend fun delete(id: String) {
        Notifications.cancelAccount(app, id)
        WorkManager.getInstance(app).cancelUniqueWork(OutboxWorker.name(id))
        withContext(Dispatchers.IO) {
            synchronized(stores) { stores.remove(id) }
            synchronized(dbs) { dbs.remove(id) }?.close()
            app.deleteDatabase(dbName(id))
            AtomicFile(File(dir, "$id.bin")).delete()
            outboxDir(app, id).deleteRecursively()
        }
    }

    companion object {
        fun dbName(id: String) = "account-$id.db"

        /** Where [id]'s outbox keeps the files of its messages. */
        fun outboxDir(app: android.content.Context, id: String) = File(app.filesDir, "outbox/$id")
    }
}
