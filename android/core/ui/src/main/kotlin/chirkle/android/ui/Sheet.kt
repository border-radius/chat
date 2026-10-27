// A bottom sheet whose last row clears the navigation bar on every Android version. The sheet is its own window, and
// before Android 11 that window draws under the navigation bar without being told its height; so the height is read
// from the screen behind it, and the sheet's own insets are not used.
package chirkle.android.ui

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChirkleSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    // Open all the way: the sheets are short, or scroll inside (a half-open sheet cut their last rows off).
    val state = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, contentWindowInsets = { WindowInsets(0, 0, 0, 0) }) {
        content()
        Spacer(Modifier.height(bottom + 8.dp))
    }
}
