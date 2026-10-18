// The image and video viewer (DESIGN.md §17.7): every image and video of the room around the one opened, swiped
// through, pinch to zoom. Videos play with Media3, which only this module carries (ANDROID.md §4.1, §11).
package chat.android.feature.viewer

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.compose.PlayerSurface
import chat.android.data.lib.Pages
import chat.android.data.lib.attachmentName
import chat.android.data.lib.isMedia
import chat.android.data.lib.isVideo
import chat.android.data.model.Cursor
import chat.android.data.model.Message
import chat.android.ui.ChatIcons
import chat.android.ui.Images
import chat.android.ui.LocalServices
import coil3.compose.SubcomposeAsyncImage
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

private data class Item(val m: Message, val file: String)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ViewerScreen(roomId: String, msgId: String, file: String, onClose: () -> Unit) {
    val services = LocalServices.current
    val items by produceState<List<Item>?>(null, roomId, msgId) {
        value = runCatching {
            val m = services.api.getMessage(msgId)
            val c = Cursor(m.created, m.id)
            coroutineScope {
                val before = async { services.api.page(Pages.withFiles(Pages.older(roomId, c))) }
                val after = async { services.api.page(Pages.withFiles(Pages.newer(roomId, c))) }
                (before.await().reversed() + m + after.await())
            }.flatMap { msg -> msg.files.filter { isMedia(msg.attachmentName(it)) }.map { Item(msg, it) } }
        }.getOrElse { listOf() }
    }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        val list = items
        when {
            list == null -> CircularProgressIndicator(Modifier.align(Alignment.Center))
            list.isEmpty() -> Text("That message isn't available any more.", color = Color.White, modifier = Modifier.align(Alignment.Center))
            else -> {
                val start = list.indexOfFirst { it.m.id == msgId && it.file == file }.coerceAtLeast(0)
                val pager = rememberPagerState(initialPage = start) { list.size }
                HorizontalPager(pager, Modifier.fillMaxSize(), key = { "${list[it].m.id}/${list[it].file}" }) { page ->
                    val item = list[page]
                    val name = item.m.attachmentName(item.file)
                    if (isVideo(name)) Video(item.m, item.file, pager.currentPage == page) else Picture(item.m, item.file, name)
                }
                val current = list[pager.currentPage]
                Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().background(Color.Black.copy(alpha = 0.5f)).systemBarsPadding().padding(16.dp)) {
                    Text(current.m.attachmentName(current.file), color = Color.White, style = MaterialTheme.typography.bodyMedium)
                    current.m.expand?.author?.let { Text(it.name, color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.bodySmall) }
                    Text("${pager.currentPage + 1} of ${list.size}", color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).systemBarsPadding().padding(8.dp)) {
            Icon(ChatIcons.Close, contentDescription = "Close", tint = Color.White)
        }
    }
}

@Composable
private fun Picture(m: Message, file: String, name: String) {
    val services = LocalServices.current
    val context = LocalContext.current
    val token by produceState(services.tokens.current) { value = runCatching { services.tokens.ensure() }.getOrDefault("") }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val url = services.api.fileUrl(m, file, token = token)
    SubcomposeAsyncImage(
        model = Images.request(context, url),
        contentDescription = name,
        contentScale = ContentScale.Fit,
        loading = { Box(Modifier.fillMaxSize()) { CircularProgressIndicator(Modifier.align(Alignment.Center)) } },
        error = { Box(Modifier.fillMaxSize()) { Text("Couldn't load image.", color = Color.White, modifier = Modifier.align(Alignment.Center)) } },
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { scale = if (scale > 1f) 1f else 2.5f; offset = Offset.Zero })
            }
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
    )
}

// PlayerSurface is Media3's Compose surface, still marked unstable API.
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
private fun Video(m: Message, file: String, active: Boolean) {
    val services = LocalServices.current
    val context = LocalContext.current
    var failed by remember { mutableStateOf(false) }
    val player = remember { ExoPlayer.Builder(context).build() }
    DisposableEffect(player) { onDispose { player.release() } }
    LaunchedEffect(m.id, file) {
        val token = runCatching { services.tokens.ensure() }.getOrDefault("")
        player.addListener(object : androidx.media3.common.Player.Listener {
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                failed = true
            }
        })
        player.setMediaItem(MediaItem.fromUri(services.api.fileUrl(m, file, token = token).toString()))
        player.prepare()
    }
    LaunchedEffect(active) { player.playWhenReady = active }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        PlayerSurface(player, Modifier.fillMaxSize().semantics { contentDescription = m.attachmentName(file) })
        if (failed) Text("Couldn't play video.", color = Color.White)
        var playing by remember { mutableStateOf(true) }
        IconButton(onClick = { playing = !playing; player.playWhenReady = playing }, modifier = Modifier.align(Alignment.Center).size(64.dp)) {
            Icon(if (playing) ChatIcons.Pause else ChatIcons.Play, contentDescription = if (playing) "Pause" else "Play", tint = Color.White.copy(alpha = 0.8f), modifier = Modifier.size(48.dp))
        }
    }
}
