package chat.android.data.testing

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import chat.android.data.db.ChatDatabase
import chat.android.data.pb.AuthStore
import chat.android.data.pb.MemoryAuthStore
import chat.android.data.pb.Session
import chat.android.data.repo.AccountEnv
import chat.android.data.repo.AccountIndex
import chat.android.data.repo.AccountRef
import chat.android.data.repo.SessionHooks

/** Accounts kept in memory (ANDROID.md §17.1), optionally starting with [initial]: server and session per account. */
class MemoryAccountEnv(initial: List<Pair<String, Session>> = emptyList()) : AccountEnv {
    var index = AccountIndex(initial.mapIndexed { i, (server, _) -> AccountRef("acct$i", server, i.toLong()) }, if (initial.isEmpty()) "" else "acct0")
    val stores = initial.mapIndexed { i, (_, s) -> "acct$i" to MemoryAuthStore(s) }.toMap(mutableMapOf<String, AuthStore>())
    val dbs = mutableMapOf<String, ChatDatabase>()
    val deleted = mutableListOf<String>()

    override suspend fun readIndex() = index

    override suspend fun writeIndex(index: AccountIndex) {
        this.index = index
    }

    override suspend fun authStore(id: String): AuthStore = stores.getOrPut(id) { MemoryAuthStore() }

    override fun database(id: String): ChatDatabase = dbs.getOrPut(id) {
        Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ChatDatabase::class.java).allowMainThreadQueries().build()
    }

    override fun hooks(id: String) = object : SessionHooks {}

    override suspend fun delete(id: String) {
        deleted += id
        stores.remove(id)
        dbs.remove(id)?.close()
    }
}
