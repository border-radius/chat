// Message text with its links (DESIGN.md §7.6.3): what linkify() finds, opened in Custom Tabs, never in the app.
package chirkle.android.ui

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.graphics.Color
import chirkle.android.data.lib.TextPart
import chirkle.android.data.lib.linkify

/** [text] with its http(s) links as links in [color]; [open] is called with a link's address. */
fun linked(text: String, color: Color, open: (String) -> Unit): AnnotatedString = buildAnnotatedString {
    val style = TextLinkStyles(SpanStyle(color = color, textDecoration = TextDecoration.Underline))
    for (part in linkify(text)) {
        when (part) {
            is TextPart.Plain -> append(part.text)
            is TextPart.Link -> withLink(LinkAnnotation.Clickable(part.href, style) { open(part.href) }) { append(part.text) }
        }
    }
}

/** Open a web address in a Custom Tab (http and https only: that is all linkify() makes links of). */
fun openLink(context: Context, href: String) {
    val uri = Uri.parse(href)
    if (uri.scheme != "https" && uri.scheme != "http") return
    runCatching { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri) }
}
