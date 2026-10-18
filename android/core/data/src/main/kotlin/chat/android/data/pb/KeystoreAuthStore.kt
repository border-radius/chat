package chat.android.data.pb

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts and decrypts the stored session. */
interface SecretBox {
    fun seal(plain: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray
}

/** AES-GCM with a key that never leaves the Android Keystore (ANDROID.md §10). */
class KeystoreBox(private val alias: String = "chat.session") : SecretBox {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    override fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return byteArrayOf(c.iv.size.toByte()) + c.iv + c.doFinal(plain)
    }

    override fun open(sealed: ByteArray): ByteArray {
        val ivSize = sealed[0].toInt()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 1, ivSize))
        return c.doFinal(sealed, 1 + ivSize, sealed.size - 1 - ivSize)
    }
}

/**
 * The session in a file, encrypted ([box]). Read once at start ([load]); every save writes it again. A file that can't
 * be read (another device's backup, a lost key) is no session.
 */
class FileAuthStore(private val file: File, private val box: SecretBox) : AuthStore {
    private val state = MutableStateFlow(Session.NONE)
    override val session: StateFlow<Session> = state.asStateFlow()

    /** Read the stored session (call off the main thread). */
    fun load() {
        val atomic = AtomicFile(file)
        state.value = runCatching {
            PbJson.decodeFromString(Session.serializer(), String(box.open(atomic.readFully())))
        }.getOrDefault(Session.NONE)
    }

    @Synchronized
    override fun save(session: Session) {
        state.value = session
        val atomic = AtomicFile(file)
        if (session.token.isEmpty()) {
            atomic.delete()
            return
        }
        val out = atomic.startWrite()
        try {
            out.write(box.seal(PbJson.encodeToString(Session.serializer(), session).toByteArray()))
            atomic.finishWrite(out)
        } catch (e: Exception) {
            atomic.failWrite(out)
        }
    }
}
