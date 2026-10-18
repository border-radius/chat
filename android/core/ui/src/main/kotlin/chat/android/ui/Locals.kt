package chat.android.ui

import androidx.compose.runtime.staticCompositionLocalOf
import chat.android.data.repo.Accounts
import chat.android.data.repo.ChatServices

/** The active account's services (ANDROID.md §4, §17), provided by :app around every screen. */
val LocalServices = staticCompositionLocalOf<ChatServices> { error("No ChatServices provided") }

/** Every account (§17): switching, adding one. Null where a screen is shown without them (some tests). */
val LocalAccounts = staticCompositionLocalOf<Accounts?> { null }
