// The site's mark: its logo when it has one (§24), else the app's own: the accent gradient with a speech bubble, as on
// the launcher icon.
package chirkle.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage

@Composable
fun BrandMark(logo: String, size: Dp = 32.dp, modifier: Modifier = Modifier) {
    if (logo.isNotEmpty()) {
        AsyncImage(logo, contentDescription = null, modifier = modifier.size(size).clip(RoundedCornerShape(size * 0.28f)))
        return
    }
    Box(modifier.size(size).clip(RoundedCornerShape(size * 0.3f)).background(Chirkle.colors.gradient), contentAlignment = Alignment.Center) {
        Icon(ChirkleIcons.Brand, contentDescription = null, tint = Color.White, modifier = Modifier.size(size * 0.6f).offset(y = size * 0.04f))
    }
}
