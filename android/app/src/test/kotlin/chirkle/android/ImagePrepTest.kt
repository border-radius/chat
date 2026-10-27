package chirkle.android

import android.graphics.Bitmap
import android.graphics.Color
import androidx.exifinterface.media.ExifInterface
import chirkle.android.ui.ImagePrep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

// Photos are re-encoded before upload (DESIGN.md §15.3), which drops their EXIF: they must be upright first.
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ImagePrepTest {
    @get:Rule val tmp = TemporaryFolder()

    /** A 40×20 JPEG, its left half red, saying it must be turned a quarter clockwise (a phone held upright). */
    private fun photo(orientation: Int) = tmp.newFile("photo-$orientation.jpg").also { f ->
        val b = Bitmap.createBitmap(40, 20, Bitmap.Config.ARGB_8888)
        for (x in 0 until 40) for (y in 0 until 20) b.setPixel(x, y, if (x < 20) Color.RED else Color.BLUE)
        f.outputStream().use { b.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        ExifInterface(f.path).apply { setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString()); saveAttributes() }
    }

    private fun red(c: Int) = Color.red(c) > 200 && Color.blue(c) < 80

    @Test fun `before Android 9 a photo is turned upright as its EXIF says`() {
        val b = ImagePrep.decodeLegacy(photo(ExifInterface.ORIENTATION_ROTATE_90), 2048)!!
        assertEquals(20, b.width)
        assertEquals(40, b.height)
        // A quarter turn clockwise: the left half is now the top.
        assertTrue(red(b.getPixel(10, 5)))
        assertTrue(!red(b.getPixel(10, 35)))
    }

    @Test fun `an upright photo stays as it is`() {
        val b = ImagePrep.decodeLegacy(photo(ExifInterface.ORIENTATION_NORMAL), 2048)!!
        assertEquals(40, b.width)
        assertTrue(red(b.getPixel(5, 10)))
    }
}
