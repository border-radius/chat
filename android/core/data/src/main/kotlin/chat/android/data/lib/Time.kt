// PocketBase datetimes (DESIGN.md §6): "2026-10-10 12:34:56.789Z", fixed width, so string order is time order.
package chat.android.data.lib

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

private val PB_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

/** "2026-10-10 12:34:56.789Z" → epoch ms, or [Long.MIN_VALUE] for "" or anything unreadable. */
fun parsePb(s: String): Long =
    if (s.isEmpty()) Long.MIN_VALUE else runCatching { Instant.parse(s.replace(' ', 'T')).toEpochMilli() }.getOrDefault(Long.MIN_VALUE)

/** epoch ms → PocketBase datetime. */
fun toPb(ms: Long): String = PB_FORMAT.format(Instant.ofEpochMilli(ms))
