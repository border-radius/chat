// Where accounts live on the device (ANDROID.md §17.1): the index and each session encrypted in no-backup storage,
// a database per account, its outbox files under files/outbox/<id>.
package chirkle.android

import android.util.AtomicFile
import androidx.work.WorkManager
import chirkle.android.data.db.ChirkleDatabase
import chirkle.android.data.pb.AuthStore
import chirkle.android.data.pb.FileAuthStore
import chirkle.android.data.pb.KeystoreBox
import chirkle.android.data.pb.PbJson
import chirkle.android.data.repo.AccountEnv
import chirkle.android.data.repo.AccountIndex
import chirkle.android.data.repo.SessionHooks
import chirkle.android.notify.Notifications
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

class AppAccountEnv(private val app: ChirkleApp) : AccountEnv {
    private val box = KeystoreBox()
    private val dir get() = File(app.noBackupFilesDir, "accounts").apply { mkdirs() }
    private val indexFile get() = AtomicFile(File(app.noBackupFilesDir, "accounts.bin"))
    private val stores = mutableMapOf<String, FileAuthStore>()
    private val dbs = mutableMapOf<String, ChirkleDatabase>()

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

    override fun database(id: String): ChirkleDatabase = synchronized(dbs) { dbs.getOrPut(id) { ChirkleDatabase.open(app, dbName(id)) } }

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
