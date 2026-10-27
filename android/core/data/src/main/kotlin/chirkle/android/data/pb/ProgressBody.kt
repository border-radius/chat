package chirkle.android.data.pb

import okhttp3.MediaType
import okhttp3.RequestBody
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer

/** A request body that reports how much of it has been written, 0 to 1 (an upload's progress, §17.4). */
internal class ProgressBody(private val body: RequestBody, private val onProgress: (Float) -> Unit) : RequestBody() {
    override fun contentType(): MediaType? = body.contentType()

    override fun contentLength(): Long = body.contentLength()

    override fun writeTo(sink: BufferedSink) {
        val total = contentLength()
        var written = 0L
        var reported = -1
        val counting = object : ForwardingSink(sink) {
            override fun write(source: Buffer, byteCount: Long) {
                super.write(source, byteCount)
                written += byteCount
                if (total > 0) {
                    val pct = (written * 100 / total).toInt()
                    if (pct != reported) {
                        reported = pct
                        onProgress(written.toFloat() / total)
                    }
                }
            }
        }.buffer()
        body.writeTo(counting)
        counting.flush()
    }
}
