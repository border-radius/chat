// Images (ANDROID.md §7.3): Coil on the app's OkHttp. An attachment's URL carries a short-lived file token (§17.3); its
// cache keys leave the token out, so a new token never downloads a thumbnail again (the web's service worker, §27.2).
package chat.android.ui

import android.content.Context
import coil3.ImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.ImageRequest
import coil3.request.crossfade
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okio.Path.Companion.toOkioPath

object Images {
    fun loader(context: Context, http: OkHttpClient): ImageLoader = ImageLoader.Builder(context)
        .components { add(OkHttpNetworkFetcherFactory(callFactory = { http })) }
        .memoryCache { MemoryCache.Builder().maxSizePercent(context, 0.15).build() }
        .diskCache { DiskCache.Builder().directory(context.cacheDir.resolve("images").toOkioPath()).maxSizeBytes(100L * 1024 * 1024).build() }
        .crossfade(false)
        .build()

    /** The URL without its token: what the image is cached as. */
    fun cacheKey(url: HttpUrl): String = url.newBuilder().removeAllQueryParameters("token").build().toString()

    /** A request for [url] (which may carry a file token), cached under its address without the token. */
    fun request(context: Context, url: HttpUrl): ImageRequest {
        val key = cacheKey(url)
        return ImageRequest.Builder(context).data(url.toString()).memoryCacheKey(key).diskCacheKey(key).build()
    }
}
