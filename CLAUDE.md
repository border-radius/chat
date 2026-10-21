# Instructions for Claude

## The Android app is frozen (since 2026-10-21)

Work on the web client and the server only. Until the user says the mobile app is unfrozen:

- Don't edit, build, test, lint or upgrade anything in `android/`, and don't update `docs/ANDROID.md` or
  `android/PARITY.md` to describe new work.
- Don't port web features or fixes to the app, and don't change it to follow server, API, schema or migration changes.
- Keep the server's app-only features working as they are (push notifications, `/.well-known/assetlinks.json`,
  `min_android_version`), but don't extend them.
- If a change would break the app, say so in your reply instead of fixing the app.
