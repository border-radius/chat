package chirkle.android.ui

import androidx.compose.runtime.staticCompositionLocalOf
import chirkle.android.data.repo.Accounts
import chirkle.android.data.repo.ChirkleServices

/** The active account's services (ANDROID.md §4, §17), provided by :app around every screen. */
val LocalServices = staticCompositionLocalOf<ChirkleServices> { error("No ChirkleServices provided") }

/** Every account (§17): switching, adding one. Null where a screen is shown without them (some tests). */
val LocalAccounts = staticCompositionLocalOf<Accounts?> { null }
