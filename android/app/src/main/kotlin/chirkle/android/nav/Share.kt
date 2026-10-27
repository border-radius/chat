package chirkle.android.nav

import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.IntentCompat

/** Text and files shared into the app (§9.3): the Android form of dropping files on the web composer. */
data class Shared(val text: String, val uris: List<Uri>, val target: String? = null)

object ShareInbox {
    var pending by mutableStateOf<Shared?>(null)

    /** The share in [intent], if it is one. */
    fun read(intent: Intent): Shared? {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> return null
        }
        if (text.isBlank() && uris.isEmpty()) return null
        return Shared(text, uris)
    }
}
