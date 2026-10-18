// Light and dark themes in the web app's colours (DESIGN.md §7.8: web/styles/app/tokens.css), following the system.
// Dynamic colour is off: the app looks the same on every phone, and like the web app.
package chat.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** The tokens Material's scheme has no slot for. */
@Immutable
data class ChatColors(
    val muted: Color,
    val border: Color,
    val hover: Color,
    val highlight: Color,
    val tint: Color,
    val own: Color,
    val gradient: Brush,
)

val LocalChatColors = staticCompositionLocalOf {
    ChatColors(Color.Gray, Color.LightGray, Color.LightGray, Color.Yellow, Color.Transparent, Color.LightGray, Brush.linearGradient(listOf(Color.Gray, Color.Gray)))
}

private val Accent = Color(0xFF5B3DF5)
private val Accent2 = Color(0xFFC42A7C)
private val Gradient = Brush.linearGradient(listOf(Color(0xFF6A4BFF), Color(0xFFC42A7C)))

private val Light: ColorScheme = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    secondary = Accent2,
    onSecondary = Color.White,
    background = Color(0xFFFBFAFF),
    onBackground = Color(0xFF1D1530),
    surface = Color(0xFFFBFAFF),
    onSurface = Color(0xFF1D1530),
    surfaceVariant = Color(0xFFF1EEFC),
    onSurfaceVariant = Color(0xFF5E5874),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF6F4FE),
    surfaceContainer = Color(0xFFF1EEFC),
    surfaceContainerHigh = Color(0xFFECE8FB),
    surfaceContainerHighest = Color(0xFFE9E4FB),
    outline = Color(0xFFCFC7EE),
    outlineVariant = Color(0xFFE3DDF5),
    error = Color(0xFFC41D36),
    onError = Color.White,
    primaryContainer = Color(0xFFE6E0FF),
    onPrimaryContainer = Color(0xFF1D1530),
    secondaryContainer = Color(0xFFE9E4FB),
    onSecondaryContainer = Color(0xFF1D1530),
)

private val Dark: ColorScheme = darkColorScheme(
    primary = Color(0xFFA99BFF),
    onPrimary = Color(0xFF1A1726),
    secondary = Color(0xFFE47AB0),
    onSecondary = Color(0xFF1A1726),
    background = Color(0xFF1A1726),
    onBackground = Color(0xFFEFECFA),
    surface = Color(0xFF1A1726),
    onSurface = Color(0xFFEFECFA),
    surfaceVariant = Color(0xFF13111D),
    onSurfaceVariant = Color(0xFFA8A2C0),
    surfaceContainerLowest = Color(0xFF13111D),
    surfaceContainerLow = Color(0xFF1F1B2E),
    surfaceContainer = Color(0xFF242036),
    surfaceContainerHigh = Color(0xFF2A2540),
    surfaceContainerHighest = Color(0xFF2F2A45),
    outline = Color(0xFF433C60),
    outlineVariant = Color(0xFF2F2A45),
    error = Color(0xFFFF7A8F),
    onError = Color(0xFF1A1726),
    primaryContainer = Color(0xFF3A3170),
    onPrimaryContainer = Color(0xFFEFECFA),
    secondaryContainer = Color(0xFF2A2540),
    onSecondaryContainer = Color(0xFFEFECFA),
)

private val LightChat = ChatColors(
    muted = Color(0xFF5E5874),
    border = Color(0xFFE3DDF5),
    hover = Color(0xFFE9E4FB),
    highlight = Color(0xFFFFF1B8),
    tint = Accent.copy(alpha = 0.12f),
    own = Color(0xFFEDE8FF),
    gradient = Gradient,
)

private val DarkChat = ChatColors(
    muted = Color(0xFFA8A2C0),
    border = Color(0xFF2F2A45),
    hover = Color(0xFF2A2540),
    highlight = Color(0xFF3D3314),
    tint = Color(0xFFA99BFF).copy(alpha = 0.14f),
    own = Color(0xFF2C2650),
    gradient = Gradient,
)

/** The avatar palette (§15.4): white text on each, at least 4.5:1, in both themes (web/styles/app/avatars.css). */
val AvatarPalette = listOf(
    Color(0xFFC4213B), Color(0xFFB04A00), Color(0xFF7A6000), Color(0xFF22803A),
    Color(0xFF00796B), Color(0xFF1D63D8), Color(0xFF7B3FE4), Color(0xFFC01A6E),
)

private val ChatShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun ChatTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalChatColors provides if (dark) DarkChat else LightChat) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, shapes = ChatShapes, content = content)
    }
}

object Chat {
    val colors: ChatColors
        @Composable get() = LocalChatColors.current
}
