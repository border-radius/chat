// Which emoji this device can draw. The picker offers the web's list (what the server accepts, §20.1), and an older
// Android's emoji font lacks the newest of them: those would show as empty boxes, so they are left out.
package chat.android.ui

import android.graphics.Paint
import java.util.concurrent.ConcurrentHashMap

object Glyphs {
    private val paint = Paint()
    private val known = ConcurrentHashMap<String, Boolean>()

    fun canDraw(emoji: String): Boolean = known.getOrPut(emoji) { synchronized(paint) { paint.hasGlyph(emoji) } }
}
