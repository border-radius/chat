// Image preparation before upload (DESIGN.md §15.3; web/src/lib/image.ts): scaled so the longest edge is at most
// maxEdge (512 px for avatars, 2048 for attachments) and re-encoded, PNG as PNG and the rest as JPEG, which drops EXIF
// (GPS location). GIFs stay as they are (re-encoding drops the animation); anything that fails stays as it was.
package chat.android.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.os.Build
import java.io.File

object ImagePrep {
    const val AVATAR_EDGE = 512
    const val ATTACHMENT_EDGE = 2048
    private val REENCODE = setOf("image/jpeg", "image/png", "image/webp")

    /** The size of a w×h image scaled down (never up) so its longest edge is at most [maxEdge]. */
    fun fitWithin(w: Int, h: Int, maxEdge: Int): Pair<Int, Int> {
        val scale = minOf(1.0, maxEdge.toDouble() / maxOf(w, h, 1))
        return maxOf(1, Math.round(w * scale).toInt()) to maxOf(1, Math.round(h * scale).toInt())
    }

    /**
     * [file] (of [type]) prepared into a new file next to it, or null to send it as it is. Returns the new file, its
     * name and type.
     */
    fun prepare(file: File, name: String, type: String, maxEdge: Int): Triple<File, String, String>? {
        if (type !in REENCODE) return null
        return runCatching {
            val bitmap = decode(file, maxEdge) ?: return null
            val (w, h) = fitWithin(bitmap.width, bitmap.height, maxEdge)
            val scaled = if (w == bitmap.width && h == bitmap.height) bitmap else Bitmap.createScaledBitmap(bitmap, w, h, true)
            val png = type == "image/png"
            val outName = when {
                png && name.endsWith(".png", true) -> name
                !png && (name.endsWith(".jpg", true) || name.endsWith(".jpeg", true)) -> name
                else -> name.substringBeforeLast('.').ifEmpty { "image" } + if (png) ".png" else ".jpg"
            }
            val out = File(file.parentFile, "prepared-$outName")
            out.outputStream().use { scaled.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 85, it) }
            Triple(out, outName, if (png) "image/png" else "image/jpeg")
        }.getOrNull()
    }

    /** Decoded about at size, upright: ImageDecoder applies the EXIF orientation (Android 9+). */
    private fun decode(file: File, maxEdge: Int): Bitmap? {
        if (Build.VERSION.SDK_INT >= 28) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { d, info, _ ->
                val (w, h) = fitWithin(info.size.width, info.size.height, maxEdge)
                d.setTargetSize(w, h)
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}
