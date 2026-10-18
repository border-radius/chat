// Client-made record ids (DESIGN.md §7.5, §17.4): PocketBase's format, 15 characters of [a-z0-9]. A retried send reuses
// its id, so the server never makes a duplicate.
package chat.android.data.lib

import java.security.SecureRandom

private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
private const val LENGTH = 15
/** Bytes at or above this are skipped, so every character is equally likely. */
private const val LIMIT = 256 - 256 % 36
private val random = SecureRandom()

fun newId(): String {
    val out = StringBuilder(LENGTH)
    val buf = ByteArray(LENGTH * 2)
    while (out.length < LENGTH) {
        random.nextBytes(buf)
        for (b in buf) {
            val v = b.toInt() and 0xff
            if (v < LIMIT) out.append(ALPHABET[v % ALPHABET.length])
            if (out.length == LENGTH) break
        }
    }
    return out.toString()
}
