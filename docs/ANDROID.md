# Chat — Android App Design Document

| | |
|---|---|
| **Status** | **Frozen (2026-10-21): no work on the app until it is unfrozen, see [`CLAUDE.md`](../CLAUDE.md).** Built (2026-10-18): what changed in implementation is §16. Several servers and accounts: §17 (2026-10-19) |
| **Date** | 2026-10-18 |
| **Scope** | A native Android client with the web app's features (§1–§14); the server additions it needs: push notifications §8, App Links §9.4, minimum app version §12.4 |

Code and tests cite this document by section number, prefixed `A` to tell it from [`DESIGN.md`](DESIGN.md) (e.g.
`A§6.3`); `§n` alone means DESIGN.md. **Don't renumber sections:** append new ones, and mark obsolete ones as such
instead of deleting them.

---

## 1. Summary

The Android app is a native client for any server running the chat (several at once, §17), written in **Kotlin** with
**Jetpack Compose**. It does everything the web app does, with the same rules and limits, and adds push notifications
(which a phone chat app can't do without).

It is built to be **lightweight and fast**: a download under 6 MB, a first frame in under 500 ms, a room that was open
before shown in under 100 ms. Every screen reads a local SQLite database first; the network only writes to it.

An earlier Expo (React Native) app was removed on 2026-10-18. This one replaces it: native code is how we meet the size
and speed goals.

## 2. Goals and non-goals

### Goals

1. **Parity with the web app.** Every feature in the README works the same way (§3 lists them all). Access control stays
   in PocketBase API rules; the app enforces the same limits as `web/src/lib/limits.ts` before the server does.
2. **Lightweight.** ≤ 6 MB download. No heavy DI framework, no RxJava, no Retrofit, no WebView for any screen, no
   Firebase beyond messaging.
3. **Fast.** The budgets of §11, measured in CI and failing the build when missed, like the web's bundle budget (§7.7).
4. **Offline-tolerant.** The room list and each room's latest messages come from the local database, then the network
   fills in. Sends queue and retry safely (§17.4's client IDs).
5. **Small server footprint.** Three additions only: push (§8), the App Links file (§9.4) and a minimum app version
   (§12.4). No route the web app doesn't use is added for the app's convenience.
6. **Tested** against a real, throwaway PocketBase, like the web app (§13).

### Non-goals (v1)

These are left out on purpose. The design should not block them later.

- A tablet two-pane layout beyond what adaptive Compose gives (v1.1)
- Wear OS, Android Auto, home screen widgets
- Features the web app lacks: typing indicators, presence, voice messages, calls, mentions, per-room mute
- iOS (Kotlin Multiplatform could share `:core:data` later; nothing here should depend on Android in that module
  beyond Room and WorkManager)

## 3. Feature parity

Each web feature, the Android screen or mechanism for it, and the API it uses. Only deep links need server work.

| Web feature (DESIGN.md) | Android | API |
|---|---|---|
| Sign up, log in, invite code, session restore (§22, §24.2) | Login / Sign up screen; token in DataStore, encrypted (§10); `authRefresh` after launch, off the critical path | `users` auth, `site.invite_only` |
| Branding: title and logo (§24) | Site record cached; shown in the top bar and on the login screen | `site` |
| Room list: create, hide, archive, unread counts (§5, §18) | Rooms screen; live; hide from the row's menu; badges | `rooms`, `hidden_rooms`, `GET /api/chat/unread` |
| Room access: Private / Public / Open Air, members, who can post (§23, §23.6) | Room access sheet: three radio cards, add/remove people, the same warnings; read-only Members for others | `rooms.update` (visibility, members, writers) |
| Guests read Open Air rooms (§23.3) | Signed-out home lists Open Air rooms; read-only room; "Log in to post" bar | public rules on `rooms`, `messages` |
| Live messages, edits, soft deletes (§7.5, §7.6.1–2) | Realtime into the DB; the UI observes the DB | `/api/realtime`, `messages` |
| Full history, keyset paging (§6, §7.5) | Paging 3, both directions, `(created, id)` cursors | `messages.getList` |
| Open at the first unread, "New" line, Jump to latest (§18.5, §22.7) | Initial window around the first unread; divider item that fades; button when scrolled up | `GET /api/chat/unread/{room}`, `POST /api/chat/reads` |
| Direct messages, close and reopen (§16) | "New message" user search; DM rows in the list | `POST /api/chat/dms`, `GET /api/chat/users` |
| Avatars, profile, unique name, password, log out (§15, §22.1–2) | Profile screen; photo picker, crop and resize on the device to §15.3's sizes | `users.update`, `POST /api/chat/password` |
| Search in a room or DM (§29) | Search bar in the room's top bar, 50 results a page; picking one opens the history around it | `messages` with `text_key` filters |
| Replies, jump to the original (§19) | Swipe right or menu → Reply; tap the quote to load around the original | `reply_to`, `expand` |
| Clickable links (§7.6.3) | Same rules as `lib/links.ts` (http, https, www. only); open in Custom Tabs | client only |
| Link previews (§28) | Favicon (`data:` URL) and title under the message | `messages.previews` |
| Emoji picker and reactions (§20) | `emoji2-emojipicker` in the composer; reaction chips; quick reactions in the long-press menu | `POST /api/chat/reactions` |
| Attachments: 10 files of 20 MB, progress, thumbnails, "+N", audio (§17) | System photo picker and document picker; upload with progress (§8.3); 4-tile grid; inline audio player | `messages.create` multipart, file tokens |
| Image and video viewer, swipe (§17.7) | Full-screen pager, pinch zoom; Media3 for video, in a module loaded on first use | protected files |
| Select up to 50, forward, delete together (§21) | Selection mode from long-press; forward target picker | `POST /api/chat/forward`, `POST /api/chat/delete` |
| Unread counts in sync across devices (§18.3) | `room_reads` events; launcher badge from the total (instead of the favicon, §22.4) | `room_reads`, `/api/chat/unread` |
| Drafts kept per room (§22.3) | Saved to the DB as you type, restored on open | client only |
| Fast room switching, prefetch (§7.5, room cache) | The DB is the cache; unread rooms prefetched (§6.3) | as above |
| Telegram bridge (§26) | Nothing extra: stand-in users and service messages render as on the web | server only |
| Light and dark themes (§7.8) | Material 3 with the web's colours, following the system; dynamic colour off | client only |
| Paths `/r/:id`, `/r/:id/m/:msgId` (§7.1) | Android App Links on the server's domain (§9.4) | `assetlinks.json` |
| Installable PWA (§27) | Not needed: the app is the installed app | — |

**Beyond the web:** push notifications (§8). DESIGN.md §2 lists them as a non-goal for the web app; on a phone they are
what makes a chat app usable. Hidden rooms stay silent, as §13 decided.

## 4. Architecture

```
┌──────────────────────────── Android app ─────────────────────────────┐
│                                                                      │
│  Compose UI (Navigation 3)                                           │
│  login / rooms / room / search / viewer / profile / room access      │
│        │  observes UiState (StateFlow)                               │
│        ▼                                                             │
│  ViewModels  ◄──── Flow ────────────────────┐                        │
│        │                                    │                        │
│        ▼                                    │                        │
│  Repositories (rooms, messages, unread, account, search, site)       │
│        │                  │                 │                        │
│        ▼                  ▼                 │                        │
│  PbClient            WorkManager ──► Room DB (rooms, messages,       │
│  (OkHttp REST + SSE)  (sends, uploads,       reactions, drafts,      │
│        │               push fetches)         send queue)             │
└────────┼─────────────────────▲───────────────────────────────────────┘
         │ REST (JSON)  SSE    │ wakes the app (IDs only)
┌────────▼────────────────┐   ┌┴──────────────────────┐
│  PocketBase (unchanged  │──►│  FCM / UnifiedPush    │
│  API + push hook, §8)   │   └───────────────────────┘
└─────────────────────────┘
```

**One rule:** the UI reads only the local database. Network pages, realtime events and pushes all write into Room, and
its Flow queries carry the change to the screen. It is the web's room cache (§7.5) made the default for every screen:
nothing waits for the network to show what is already known.

**Why native Kotlin + Compose:** the smallest download and fastest start Android allows, and the platform's own APIs
for what a chat app needs (notifications with inline reply, the photo picker, background uploads). Rejected:

- **A WebView around the PWA:** not native, slow to start, weak notifications.
- **React Native / Expo, Flutter:** a bigger download and start cost (and we just removed an Expo app).
- **Kotlin Multiplatform shared with the web:** the web app is vanilla TypeScript; there is nothing to share.

## 5. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | Kotlin 2.2 (K2), coroutines and Flow | Structured concurrency fits realtime and paging |
| UI | Jetpack Compose (BOM), Material 3, adaptive layouts | Declarative, no XML; one theme for light and dark |
| Navigation | Navigation 3 | The back stack is state we own; simple deep links |
| HTTP | OkHttp 5 + kotlinx.serialization | Small and fast; about 20 calls don't need Retrofit |
| Realtime | `okhttp-sse` | PocketBase realtime is Server-Sent Events, the protocol `pb.ts` speaks |
| Database | Room (SQLite, KSP) | Rooms, messages, drafts and the send queue; Flow queries drive the UI |
| Paging | Paging 3 with a `RemoteMediator` | Keyset pages both ways, the DB as the single source |
| Images | Coil 3 on the same OkHttp | Compose-first, memory and disk caches, small |
| Video and audio | Media3 ExoPlayer, its own module (§4.1) | Kept out of cold start, like the web's lazy viewer chunk |
| Background work | WorkManager | Sends and uploads survive process death; progress notifications |
| Settings and token | DataStore + an Android Keystore key (AES-GCM) | Not the deprecated `security-crypto` |
| DI | A hand-written `AppGraph`, constructor injection | No Hilt/Dagger start-up or size cost for ~15 singletons |
| Emoji | `emoji2`, `emoji2-emojipicker` | Current emoji on old Android, the system's picker UI |
| Push | Firebase Cloud Messaging (messaging only); UnifiedPush as an option | FCM reaches most phones; UnifiedPush serves de-Googled ones |
| Build | Gradle version catalog, AGP 8, R8 full mode, Baseline Profiles | Small download, fast start |
| Lint | ktlint, detekt, Android lint, Compose lint | What Biome is on the web side |

**SDK levels:** minSdk 26 (Android 8.0, ~97% of active devices), targetSdk and compileSdk 36. Exact library versions
are pinned in `android/gradle/libs.versions.toml` when implementation starts, as `scripts/fetch-pocketbase.sh` pins
PocketBase.

### 5.1 Modules

```
android/
  app/              Activity, AppGraph, navigation, theme, push service, deep links
  core/data/        PbClient, Room DB, repositories, sync engine (§6), send queue
  core/ui/          colours and type, avatar, message row, linkified text, emoji
  feature/auth/     login, sign up, guest home
  feature/rooms/    room list, new room, new DM
  feature/room/     messages, composer, search, selection, room access
  feature/profile/  profile, password
  feature/viewer/   image and video viewer, Media3 (loaded on first use)
```

Few modules, for build speed. A feature module never imports another; they meet in `:app`'s navigation.

## 6. Data layer

### 6.1 `PbClient`

A port of `web/src/pb.ts` (§6): JSON or multipart requests with the auth header; a `filter()` that binds parameters as
`pb.filter()` does (never string concatenation, which prevents filter injection); the realtime protocol (one SSE
stream, the `PB_CONNECT` client id, subscriptions POSTed to `/api/realtime` and resent after reconnects with the same
backoff). It asks for the web's `MSG_FIELDS`, so it never pulls anyone's email.

**Text folding** for search (§29.1) and display names (§22.1) is a port of `foldKey` / `nameKey`: no invisible
characters, NFKC (`java.text.Normalizer`), upper then lower case, the dotted İ dropped. The web's unit cases for them
are ported as fixtures, so the two can't drift apart.

### 6.2 Database

| Table | Holds | Kept |
|---|---|---|
| `rooms` | id, name, visibility, archived, created_by, members, writers, hidden, unread, last activity | all the user can see |
| `messages` | `MSG_FIELDS` + reply, forward, files, reactions, previews; `state` (sent / pending / failed) | the latest 200 per room, for the last 30 rooms opened |
| `users` | id, name, avatar | those referenced by kept messages |
| `drafts` | room → text, reply target | until sent or cleared |
| `outbox` | client message id, room, text, files (content URIs), attempts | until the server has it |
| `site` | title, logo, invite-only flag, `min_android_version` | one row |

Messages are keyed by server id; an optimistic send uses the client-made id it will keep on the server (§17.4), so the
row never changes key and the list never jumps. A trim job drops what falls outside "Kept" after each room close.

### 6.3 Sync

1. **Launch:** show the kept room list; fetch rooms, hidden rooms and `/api/chat/unread` in parallel; prefetch the
   latest page of rooms with unread messages, as `prefetch.ts` does. To stay out of the prefetch herd (QA BUG-108,
   open on the web), a message in a room that isn't open only bumps its count; its page is fetched at launch, on a
   push, or when the room opens, never once per message.
2. **Open a room:** show the kept window at once, positioned by §18.5's rule; fetch the first unread anchor and the
   latest page in one round trip; subscribe the room's messages.
3. **Scroll:** the `RemoteMediator` fetches older or newer pages by `(created, id)` cursor with `skipTotal`.
4. **Reconnect:** after `PB_CONNECT`, resubscribe and fetch a newer page from each open room's newest kept message to
   fill the gap (`sync.ts`).
5. **Read:** `POST /api/chat/reads` once the newest message is on screen (§18.3), debounced to 1 s. `room_reads`
   events from other devices update the counts.

**Lessons from the web, applied from the start:** one request to open a room (room cache latency, 2026-10-15), no
per-record server work on list fetches (the hooks pool, 2026-10-14), filters that use the indexes (the reply cross join,
2026-10-16).

## 7. Screens

Compose screens, one `ViewModel` and one immutable `UiState` each. Routes mirror the web's paths (§7.1), so a deep link
is a route.

| Route | Screen | Notes |
|---|---|---|
| `Login`, `SignUp` | Email and password; invite code when the site asks for one | branding from the site record |
| `Home` (guest) | Open Air rooms | log in or sign up to join in |
| `Rooms` | Rooms and DMs, unread badges, archived section | new room (with "Who can see it"), new DM |
| `Room(id, msgId?)` | Messages, composer, search, selection | `msgId` opens around a message (§6 "One message") |
| `RoomAccess(id)` | Visibility, members, who can post | creator edits; others read |
| `Viewer(roomId, msgId, file)` | Images and videos of the room, swipe between them | `:feature:viewer` |
| `Profile` | Avatar, name, password, log out | |

### 7.1 Message list (hot path)

- A `LazyColumn` with `reverseLayout = true`, so new messages land at the bottom without scroll math; item keys are
  message ids, `contentType` per kind (text, media, service, deleted, "New" line, day header).
- Rows take `@Immutable` models built off the main thread; time strings come from formatters created once (the web's
  `Intl.DateTimeFormat` rule, §7.7).
- Grouping (same author within 5 minutes, no avatar repeat) and day headers are computed in the repository, not in
  composition.
- About 300 messages in memory at once, like the web's DOM window (§7.5).
- Pinning: when you are at the bottom, new messages keep you there; scrolled up, they don't move you and the Jump to
  latest button counts them (§22.7; the scroll pinning fixes of QA pass 15 apply). A message you send is followed once
  the outbox has read it back from the database and the list has composed its row: scrolled before that, the lazy list
  keeps the old bottom row in place and the new message lands under the composer.

### 7.2 Composer

Multi-line field with the 2,000-character limit counted in code points (`textLength`); emoji, attach, send. One rounded
field holds emoji at its start and attach at its end, both kept at the bottom as the text grows to six lines, then the
send circle: the text gets the width. Enter makes
a new line; a hardware keyboard sends with Enter and Ctrl+Up/Down pick the reply as on the web. Replying and editing
show a bar above the field. A room you may only read shows why instead of the composer (archived, Open Air guest, not a
writer: §23.6).

### 7.3 Images and files

Thumbnails use the server's thumb sizes (§17.5), never full images in the list. File URLs carry a short-lived file
token (§17.3) fetched and shared like `lib/token.ts` (renewed after 2 minutes). Coil's cache key is the URL **without**
the token, so a room switch or a new token never downloads a thumbnail again, as the service worker does on the web
(§27.2). Full files (viewer, downloads, video) go to the server with a fresh token.

## 8. Push notifications (server addition)

The web app has none (§2); the app needs them. The server work is a collection, a hook and a worker, built like link
previews (§28.1).

### 8.1 Data model

| Collection | Field | Type |
|---|---|---|
| `push_tokens` | `user` | relation → users, required, cascade delete |
| | `token` | text, required, unique |
| | `provider` | select `fcm` / `unifiedpush` |
| | `updated` | autodate |
| `push_queue` | `message` | relation → messages, cascade delete |

Rules on `push_tokens`: create, delete and view by the owner (`user = @request.auth.id`); no list. The app registers
its token after the first frame of a session and deletes it on log out. FCM `UNREGISTERED` answers delete the row.

### 8.2 Hook and worker

- `onRecordAfterCreateSuccess` on `messages` adds a `push_queue` row in the save's transaction (not for service
  messages, not for Telegram stand-ins' own devices, since they have none).
- A cron job sends the queue, one run at a time (a lock in the app store, as `previews.js` does): for each message,
  every user who can see the room (`canSee()` in `pb_hooks/lib/access.js`), but not its author, not those who hid the
  room, and not those whose `room_reads` is already past it.
- The payload carries **ids only** (room, message). The app fetches the message with its own session, so message text
  never passes through Google. DMs go at high priority, rooms at normal priority.
- Settings: `FCM_SERVICE_ACCOUNT` (JSON) turns FCM on; without it nothing is queued. UnifiedPush tokens are endpoint
  URLs, POSTed to directly, with the same address checks as link previews (§28.1), and with their fetcher (curl, the
  checked address pinned): a redirect isn't followed (QA BUG-141), so an endpoint must answer where it is registered.

### 8.3 On the device

- A `FirebaseMessagingService` (or UnifiedPush receiver) enqueues an expedited job: fetch the message into the DB, then
  notify.
- `MessagingStyle` notifications, one channel per kind (Direct messages, Rooms), grouped per room, with **Reply**
  (`RemoteInput`, sent through the outbox) and **Mark as read**.
- Opening a room, or reading it on another device (a `room_reads` event while the app runs, or the next push), clears
  its notification. The launcher badge is the unread total.

## 9. Platform integration

### 9.1 Realtime in the foreground only

One SSE connection while the app is visible, tied to `ProcessLifecycleOwner`; it closes 5 s after the app goes to the
background. No polling, no wake locks, no foreground service: push covers the background.

### 9.2 Sending and uploads

A send writes the message as pending, with its client id, and enqueues a WorkManager job that posts it. A retry reuses
the id, so the server never makes a duplicate (§17.4). Messages with files upload in an expedited job with a progress
notification; the row shows the progress bar. A failed send shows "Couldn't send · Retry".

### 9.3 Sharing into the app

A share target (`ACTION_SEND`, `ACTION_SEND_MULTIPLE`) for text and files opens a room picker, then the composer with
them attached: the Android form of dropping files on the web composer.

### 9.4 App Links (server addition)

`/.well-known/assetlinks.json`, served by a hook from `ANDROID_APP_ID` and `ANDROID_CERT_SHA256` (both unset → 404).
The app declares the server's host for `/r/*`, so a link to a room or a message opens in the app.

## 10. Security considerations

- The auth token is encrypted with a Keystore key and never logged. Backups (`dataExtractionRules`) leave out the
  database and the token.
- HTTPS only (network security config); cleartext is allowed for `127.0.0.1` and `10.0.2.2` in debug builds only.
- Message text is shown as text. Links follow the web's allow-list (§7.6.3) and open in Custom Tabs, never in the app.
- File tokens as in §7.3; a URL with a token is never written to the disk cache key.
- Log out clears the database, Coil's caches, pending work, notifications and the push token, as the web clears
  IndexedDB and the service worker's cache. So does a session found expired at start (the app not opened before it
  ran out): it is forgotten and its data cleared before anything shows, its rooms and DMs included (QA BUG-145, as
  the web's `forgetExpired`).
- Access control stays on the server: the app hides what you can't do, but never relies on it.
- An opt-in setting sets `FLAG_SECURE` on screens with messages.

## 11. Performance budget (enforced in CI)

The reference device is a Pixel 6a-class phone on Android 14.

| Metric | Budget | Measured by |
|---|---|---|
| Download size, per ABI | **≤ 6 MB** | `bundletool get-size total` |
| Cold start to first frame | **≤ 500 ms** | Macrobenchmark `StartupTimingMetric`, median of 10 |
| Cold start to the kept room list | ≤ 700 ms | `reportFullyDrawn()` |
| Opening a kept room | **≤ 100 ms** to the first message | Macrobenchmark trace section |
| Opening a room not kept | 1 round trip | integration test counting requests |
| Scrolling 300 messages with images | < 1% slow frames | `FrameTimingMetric` |
| Memory (PSS) in a busy room | ≤ 150 MB | `dumpsys meminfo` |
| Network when idle | 1 SSE connection | integration test |

How:

- Baseline and startup profiles for log in, the room list, opening a room and scrolling.
- R8 full mode and resource shrinking; serialization generated at compile time, no reflection.
- Nothing at start but the first screen: `AppGraph` builds singletons on first use, no `ContentProvider` initialisers,
  push registration after the first frame.
- Media3 and the viewer in their own module, loaded on first use.
- A new dependency needs its size in the PR description, as a new web dependency does (§8.1).

## 12. Build, release and versions

### 12.1 Repository

The app lives in `android/` in this repo, so a schema change and its client change land in one commit.
`docs/schema.snapshot.json` is the contract: CI runs the app's API tests whenever it changes.

### 12.2 Scripts

| Command | What it does |
|---|---|
| `./gradlew assembleDebug` | Debug build pointed at `http://10.0.2.2:8090` (the dev server from the emulator) |
| `./gradlew check` | ktlint, detekt, lint, unit and Robolectric tests |
| `./gradlew pixel6Api34DebugAndroidTest` | E2E on a Gradle Managed Device against a real PocketBase |
| `./gradlew :benchmark:connectedCheck` | Macrobenchmarks and the budgets of §11 |
| `./gradlew bundleRelease` | Signed AAB, fails over the size budget |

### 12.3 Release

AAB to Google Play (internal, closed, then production with a staged rollout) and a signed APK on GitHub Releases for
UnifiedPush users.

### 12.4 Minimum app version (server addition)

`site.min_android_version` (number, default 0), readable like the rest of the site record (§24.1). An older app shows
"Update required" with a link to the store instead of a screen that could break on a changed schema.

## 13. Testing strategy

As on the web (§9): every run starts its own PocketBase on a free port with a temp data dir; no fakes except a stub FCM
endpoint.

| Layer | Tools | Covers |
|---|---|---|
| Unit | JUnit 5, Turbine, kotlinx-coroutines-test | linkify, cursors, unread math, reaction merge, folding, drafts, outbox (cases ported from `tests/unit`) |
| Data integration | JVM tests, real PocketBase started by Gradle from `bin/pocketbase` | PbClient, SSE reconnect and gap-fill, paging both ways, the access rules as the app sees them |
| UI | Compose UI tests on Robolectric | each screen's states: empty, loading, error, guest, archived, read-only |
| End-to-end | Compose tests on a Gradle Managed Device, real PocketBase | the parity scenarios of `tests/e2e`: send, edit, reply, react, forward, attach, search, room access, guests |
| Screenshots | Roborazzi | every screen in light, dark and at 200% font size |
| Performance | Macrobenchmark, Baseline Profile generator | §11 |
| Accessibility | Compose accessibility checks, a TalkBack pass per release | labels, 48 dp touch targets, contrast |
| Server | `tests/integration/push.test.ts` | §8: who gets a push, hidden and read rooms skipped, ids only, tokens owner-only |

**Parity guard:** `android/PARITY.md` maps each web e2e spec to its Android test. A web feature without an Android
entry fails review.

**CI:** an `android` job in `.github/workflows/ci.yml`, beside the web jobs: `./gradlew check`, the managed-device run
and the size check. Macrobenchmarks run nightly on Firebase Test Lab.

## 14. Milestones

Estimates for one Android developer: about 13 weeks to a closed beta with full parity.

| # | Deliverable | Weeks | Done when |
|---|---|---|---|
| A1 | Foundation: `android/`, PbClient and SSE, auth, site record, Room DB, `AppGraph`, CI with the size check | 2 | log in and out against the dev server; CI green |
| A2 | Core chat: room list, unread counts, send/edit/delete, paging both ways, realtime, drafts, prefetch | 4 | **internal alpha:** the team uses it every day |
| A3 | Rich messages: replies, reactions, attachments, viewer, link previews, search | 3 | their parity e2e tests green |
| A4 | Rooms and people: DMs, room access, guests and Open Air, selecting and forwarding, profile and avatar | 2 | their parity e2e tests green |
| A5 | Push and polish: §8 server and app, App Links, share target, budgets, accessibility, screenshots | 2 | **closed beta:** `PARITY.md` at 100%, §11 green |

## 15. Decisions and open questions

### Decided (2026-10-18)

| Topic | Decision |
|---|---|
| Native or cross-platform | Native Kotlin and Compose (§4). |
| Source of truth on the device | The local database; the UI never renders a network response directly (§4). |
| Push content | Ids only; the app fetches the text itself (§8.2). |
| Background connection | None; realtime only in the foreground, push otherwise (§9.1). |
| Hidden rooms | Silent on Android too: no badge, no notification (§13 of DESIGN.md). |
| Where the code lives | This repo, `android/` (§12.1). |

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Web features keep landing during the build | parity moves | `PARITY.md` in review; the app's API tests run on every schema snapshot change |
| Mobile networks and Doze drop SSE | missed live updates | gap-fill on every reconnect (§6.3); push in the background |
| No FCM (de-Googled phones, some regions) | no notifications | UnifiedPush build; realtime still works in the foreground |
| Hand-written DI grows messy | slower changes | `AppGraph` stays one file; revisit Metro or kotlin-inject past 30 bindings |
| The download creeps past 6 MB | misses the goal | the CI size gate; a size note for every new dependency |

### Still open

1. **Accounts:** who owns the Firebase project and the Play Console account?
2. **UnifiedPush:** at launch or after the beta?
3. **Package name and default server** (for example `com.<org>.chat`; the default server is also the App Links host, §17.3).
4. **Web Push:** should the web app get notifications too, from the same `push_queue`?
5. **Per-room mute:** the web has hide only. Add mute to both clients, or keep hide as the one control?

## 16. Implementation (2026-10-18)

The app is in `android/`, built to this document. This section records what implementation changed, and why; the
sections above are otherwise as designed.

### 16.1 Versions

Pinned in `android/gradle/libs.versions.toml`. Current AndroidX (Compose BOM 2026.09, OkHttp 5.5) requires AGP 9.1+
and compileSdk 37, so §5's "Kotlin 2.2, AGP 8" became:

| | |
|---|---|
| Build | Gradle 9.8.1, AGP 9.4.1 (Kotlin built in: the `kotlin-android` plugin is only on the classpath, for its version), JDK 17 bytecode, built with JDK 21 |
| Kotlin | 2.4.21; KSP 2.3.12 (Room) |
| SDK | minSdk 26, targetSdk 36, compileSdk 37 |
| Modules | as §5.1, plus `:core:testing` (the throwaway PocketBase and test users, for every module's JVM tests) |

### 16.2 Changes to the design

| Design said | Built | Why |
|---|---|---|
| Paging 3 with a `RemoteMediator`; the UI reads only the database (§4, §6.3, §7.1) | `RoomController` (`core/data/.../repo/RoomController.kt`), a port of the web's `controller.ts`: a window of up to 300 messages in memory; the database keeps each room's latest page (the web's room cache, §7.5) and the screen shows it at once | A window opened around a message far back (a reply's quote, a search result) leaves gaps in what is stored, which a `RemoteMediator` over one table can't represent. The web's controller already handles every case (stale windows, the first unread message, gap fill, QA BUG-61, BUG-96, BUG-100, BUG-102), and porting it keeps the two clients alike. The room list, unread counts, drafts, the outbox and the site still come from the database at launch |
| Tables per record kind (§6.2) | `rooms`, `kept` (a room's latest page), `outbox`, `drafts`, `kv`; records stored as the JSON the server sent | One decoder for network and disk; nothing to migrate when the server adds a field |
| DataStore + Keystore for the token (§5, §10) | The session in a file (`noBackupFilesDir/session.bin`), AES-GCM with an Android Keystore key | DataStore brought a native library and 250 KB for one value |
| `emoji2-emojipicker` (§3, §5) | The web's own picker list (`lib/Emoji.kt`, checked against `pb_hooks/lib/emoji.js`) | The server accepts exactly those emoji as reactions (§20.1): the system picker would offer emoji it refuses |
| JUnit 5 (§13) | JUnit 4 | Robolectric runs on JUnit 4 only |
| Push payload, server worker (§8.2) | As designed; FCM's OAuth token is signed in the hooks (`pb_hooks/lib/google.js`, RS256 with BigInt, about 12 ms an hour) | The JSVM has no RSA, and a sidecar would break goal 5 |
| A WorkManager job for every send (§9.2) | Sends are posted in-process at once, and a WorkManager job (unique, appended) drains the outbox after a process death or offline | The same guarantees without a job's start-up delay on every message. Offline, a message waits (pending); only a server refusal shows "Not sent · Retry" |
| Upload progress notification (§8.3, §9.2) | The row's progress bar; a notification only when Android runs the job as a foreground service (before Android 12) | |
| ktlint, detekt, Compose lint (§5) | Android lint (`./gradlew check`) | Not added yet: see §16.4 |

### 16.3 Server additions

As §8.1, §9.4 and §12.4 describe: migration `1760000026_push.js`, `pb_hooks/lib/push.js`, `pb_hooks/lib/google.js`,
tested by `tests/integration/push.test.ts` against a stub FCM that checks the token's signature with the service
account's public key.

| Setting | Effect |
|---|---|
| `FCM_SERVICE_ACCOUNT` | A Firebase service account's JSON: FCM pushes on |
| `UNIFIEDPUSH=on` | UnifiedPush endpoints (public https addresses only, as link previews, §28.1) |
| `FCM_ENDPOINT`, `PUSH_ALLOW_HOSTS`, `PUSH_CRON=off` | Tests: a stub FCM, stub endpoints on 127.0.0.1, pushes only on `POST /api/push/tick` |
| `ANDROID_APP_ID`, `ANDROID_CERT_SHA256` | `/.well-known/assetlinks.json` (fingerprints comma-separated); 404 without them |
| `site.min_android_version` | Set by an admin: older apps show "Update required" |

The app reads Firebase's settings from Gradle properties (`chat.fcm.projectId`, `chat.fcm.appId`, `chat.fcm.apiKey`,
`chat.fcm.senderId`) and initialises it by hand: no google-services plugin, no ContentProvider at launch. Without them
the app has no pushes and works otherwise. `chat.server` and `chat.appId` set the release build's server and package
(open question 3).

### 16.4 Status against the milestones

| | |
|---|---|
| Done | A1–A4 in code: every screen of §7, the parity features of §3, guests, deep links, the share target, push (server and app), FLAG_SECURE, the size gate. Release APK 3.1 MB (universal) |
| Tested | 58 JVM tests in `:core:data` (the web's unit cases for links, folding, search, reactions, files, avatars and emoji; the API, realtime and reconnects, the services and the room controller against PocketBase); 22 in `:app`, 19 of them the screens on Robolectric against PocketBase (log in, sign up, send, reply, edit, delete, react, search, forward, DMs, hide, archive, room access, profile, guests, and §17's accounts: adding one on another server, switching, a bad address, logging out to another account); 12 push integration tests on the server. `android/PARITY.md` maps the web's e2e specs to them. Robolectric's main looper is paused: the UI tests move its clock on as they wait (`UiHarness.pump`), or no delay in the app would ever end |
| Not yet | Managed-device E2E and Macrobenchmarks (§11, §12.2: they need a device or emulator, which the development machine lacks); Baseline Profiles; Roborazzi screenshots; ktlint and detekt; UnifiedPush on the device (the server side is done); a TalkBack pass. §11's budgets other than size are therefore unmeasured |

## 17. Servers and accounts (2026-10-19)

The app was designed for one server, fixed at build time (§1, §12.2). It now works with **any server running the
chat**, and with **several accounts at once**, on one server or many. This section replaces what §1, §6.2, §8.3, §9.4,
§10 and §12.2 say about "the server"; those sections otherwise stand.

### 17.1 Accounts

An **account** is a server address and, once someone logs in or signs up there, a user. Each account has its own:

| | Where |
|---|---|
| Session (token and auth record) | `accounts/<id>.bin` in no-backup storage, encrypted like the one session was (§10) |
| Database (§6.2): rooms, kept pages, outbox, drafts, kv | `account-<id>.db` |
| Outbox files | `files/outbox/<id>/` |
| Push registration (§8) | a `push_tokens` row on its server, noted in its own kv |

The list of accounts and which is active are in `accounts.bin` (no-backup, encrypted: it says which servers you use).
Device settings (screenshots, §10) are the device's, in that file too, not an account's.

- **One account is active.** Its services run as before (§6.3, §9.1: realtime in the foreground, sync, prefetch).
  The others are idle: no connection, nothing polled. Push (§17.4) is how they get news; switching to one starts it.
- **An account without a user** is a guest on that server (Open Air rooms, §23.3, and the Log in screen). There is at
  most one, the active one: switching away from it removes it.
- **The same user on the same server twice** is one account: logging in again replaces the older entry.
- **Logging out** ends that account's session and clears its data (§10), and leaves you on that server's Log in
  screen, which lists your other accounts to switch to.

### 17.2 Choosing a server

- **First launch:** the build's default server (`chat.server`, §12.2) when it has one, on the Log in screen; without
  one, the app asks for a server first.
- **Log in and Sign up** show the server they act on, with **Change server**.
- **Accounts** (the brand at the top of the room list; it was in the profile until 2026-10-23) lists your accounts
  (name, server), switches between them, and has **Add account**: choose a server, then log in or sign up there. Backing out of it returns to the account you were on.
- The rooms screen shows the active account's server under its title when you have more than one account.

An address is checked before it is used:

1. `chat.example.org` means `https://chat.example.org`; a pasted room link (`…/r/…`) or admin link (`…/_/`) means its
   server. Query and fragment go.
2. Release builds take **https only**; debug builds take http too (any host: a dev server on the LAN).
3. `GET /api/health` must answer, then the site record (§24.1) must be readable: a server that isn't running the chat
   says so ("That address isn't a chat server.") instead of failing later.

### 17.3 Links

- **App Links** (§9.4) can only be verified for hosts listed in the app's manifest at build time: the default
  server's. Links on other servers open in the browser, as they did before the app was installed.
- A link the app gets (App Link, share, notification) opens in the account on that server (host and path prefix),
  the active one first, switching to it when needed. A link to the default server with no account there opens it as a
  guest.

### 17.4 Push across servers

- Each account registers the device's token with its own server. **The payload adds `user`** (the recipient's id):
  the app finds the account by user id (ids are random 15-character strings: unique across servers in practice) and
  fetches the message with that account's session. A payload without `user` (an older server) goes to the active
  account.
- `push_tokens` is unique per **(token, user)**, not per token (migration `1760000027_push_tokens_per_user.js`): two
  accounts on one server share the device's token. Registering again as the same user replaces that user's row.
- Logging out of one account deletes its row; the device's FCM token is only deleted when no account is left.
- Notifications are per account and room, grouped per account; with more than one account they show which one
  (name · server). Reply and Mark as read act as that account.
- **FCM needs the app's Firebase credentials on the server** (`FCM_SERVICE_ACCOUNT`): only servers whoever publishes
  the app gives them to. Other servers can push through **UnifiedPush** (its server side is done, §16.3; the app side
  is not yet, §16.4), or not at all: the app still works, without notifications. A relay for FCM pushes is open
  question 6.

### 17.5 Security

- Each server sees only its own account's credentials and requests. A session is never sent to another server: every
  request is built from its own account's address.
- An account's data is cleared on its log out, as the one session's was (§10); other accounts are untouched.
  Notifications and pending work of one account are cancelled without touching the others'.
- File URLs and image cache keys include the server's address, so two servers' files never share a cache entry.
- Typing a server's address trusts it with what you send there, as a browser does; https is required in release.

### 17.6 Still open

6. **Push for servers without the app's FCM credentials:** ship UnifiedPush on the device, run a push relay that holds
   the credentials (servers would authenticate to it), or both?
7. **Sharing into another account:** shares go to the active account's rooms; should the picker offer every account?

### 17.7 Implementation (2026-10-19)

`core/data` `repo/Accounts.kt` (the accounts, their index and lifecycle), `lib/Servers.kt` (addresses and links);
`app` `AppAccounts.kt` (where they live on the device); `feature/auth` `ServerScreen.kt`; `feature/profile`
`AccountsScreen.kt`; `AppRoot` in `nav/ChatNav.kt` (a back stack per account). Tested by `AccountsTest` and `ServersTest`
(`:core:data`) and `UiAccountsTest` (`:app`); the tests use the test server by two addresses (127.0.0.1 and
localhost) as two servers. An idle account's session is renewed each time the app starts (one the server refuses is
removed, as a log out would). Nothing migrates the single session of the 2026-10-18 build: it never shipped.

## 18. Unfrozen: emulator, fixes and polish (2026-10-23)

The app was frozen from 2026-10-21 to 2026-10-23 (web work only). On unfreezing it, it was run on an emulator for the
first time, tested by hand on it, polished, and given the web features added while it was frozen.

### 18.1 The emulator on the development machine

The development container has no `/dev/kvm`, so the emulator runs in software (QEMU TCG, `-accel off`, with
`-qemu -accel tcg,thread=multi` for four guest CPUs). Android 14 and 11 images do not survive it: zygote exits, or
system services time out (ANRs) and system_server restarts in a loop. The Android 9 image (`android-28;default;x86_64`)
boots in about 15 minutes and stays up. Apps run slowly (a frame can take seconds), so after installing a debug build,
`adb shell cmd package compile -m speed -f <package>` compiles it ahead of time first. Input from `adb shell input`
is dropped when it comes faster than the app takes it: text is typed a few characters at a time. With KVM, any
current image works and none of this applies.

### 18.2 Bugs fixed

| Bug | Fix |
|---|---|
| The viewer: swiping to the next image didn't work (the zoom gesture took every drag) | One finger pans only when zoomed in; at an edge the drag goes to the pager; two fingers zoom about their centre; double tap zooms on the tapped point |
| The viewer: videos were stretched to the screen | Media3's `ContentFrame` fits them; play/pause follows the player; a seek bar with times |
| The viewer: dark status bar icons on black | Light icons; the system bars hide with the viewer's own bars |
| Search: picking a result left the results over the messages, hiding the one gone to | They make way; focusing the field shows them again |
| Search: a narrower query that found the same messages kept the old highlight ("gre" of "green") | The highlighted words are Compose state |
| A single image was letterboxed in a fixed 240 dp box | The tile takes the picture's shape (at most 320 × 240 dp), remembered so a row doesn't jump when it comes back |
| A single video was a dark square | Its poster (`/api/chat/posters`, §30.1), in the video's shape |
| Bottom sheets (message actions, emoji, forward): the last row under the navigation bar (Android ≤ 10) | `ChatSheet` pads with the navigation bar's height from the screen behind it |
| Bottom sheets: menu rows on another background than the sheet | Transparent rows |
| Back in a room during search, selection or an edit left the room | Back closes search, ends the selection, cancels the edit; only then leaves |
| Bottom sheets opened half way, cutting off their last rows (Delete, the last rooms to forward to) | They open all the way (their content is short or scrolls) |
| The emoji picker showed empty boxes on older Android (emoji newer than the system font) | It leaves out the emoji the device can't draw (`Glyphs`); bundling an emoji font would cost 10 MB |
| With Dark chosen, the app started on a light window (the theme is read after the first frame) | The choice is mirrored in a small preference read in `onCreate`: the window, the system bars and (Android 12+) the splash follow it; `uiMode` changes are handled in place |
| Sharing into the app: after choosing a room, the "Share to" picker came straight back over it | Choosing a room sets the share's target, which re-ran the effect that opens the picker; it now opens only for a share without one (`UiPortsTest`) |
| Adding people to a room: someone just added was still offered as if not added | They are shown with a check; a tap takes them out again |
| The room list was empty while it loaded | A spinner on the first load |
| The themed launcher icon (Android 13+) was a blob: the dots were drawn in colour, not cut out | `ic_launcher_monochrome` with the dots cut out |
| `UiFlowTest` waited without moving the main looper on | It uses the harness's `waitFor` (which pumps, and prints the screen on a timeout) |

### 18.3 Polish

Nunito (the rounded face of the web's font stack, one variable font, 277 KB) for all text; Material's shared X-axis
transitions between screens; the brand mark (the launcher icon's bubble on the accent gradient) on Log in, the server
choice and the room list when the site has no logo; vector room marks (#, lock, globe) instead of emoji; the other
person's avatar or the room's mark in the forward and share pickers; the send button a filled accent circle;
"Logging in…" / "Checking…" on buttons while busy; a password visibility toggle; "(edited)" inline after the text;
an add-reaction chip after a message's reactions; swipe right to reply (with a haptic tick); the message being acted
on shown at the top of its action sheet, Delete in red; the other person's avatar in a DM's header; the room's picture over "Beginning of …"; images about to be sent as thumbnails in the composer; the "New" line fades out; icons in the + menu; New room focuses its name; emoji category tabs; an inline audio player with progress and
times; the viewer's bars fade, with the author, time and file name, and a Download button; notifications tinted with
the accent; the app's version at the end of the profile.

### 18.4 Web features ported

| Web | App |
|---|---|
| Appearance: System, Light, Dark (DESIGN.md §7.8) | Profile → Appearance; kept in the device settings (`DeviceSettings.theme`, the account index's `theme`), the system bars follow it |
| Media grid (§30) | The room's 🖼 button → `MediaScreen`: `GET /api/chat/media/{room}`, month headings, 60 a page, posters, a tile opens the viewer |
| Jump to (§32) | The room list's search button (or Ctrl+K / Ctrl+P): `lib/Jump.kt` ports `matches`/`score`; rooms you just had open come first (`RecentlyOpened`) |
| Media collections (§31) | §19 |

### 18.5 Tests

`JumpTest` (`:core:data`): the web's matching cases. `UiPortsTest` (`:app`): Jump to, the media grid and the viewer
from it, an empty grid, Appearance, and sharing into a room. 63 JVM tests in `:core:data` and 27 in `:app` pass; Android
lint adds no warning. The release APK is 3.48 MB (Nunito is most of the 0.24 MB added; budget 6 MB).

On the Android 9 emulator, by hand: log in, sign up (and its validation), the room list (light and dark), rooms and a DM,
sending text, emoji and images, replying (from the sheet and by swiping), starting an edit, reacting, forwarding, search,
the viewer (swiping, a video with its controls), the audio player, the media grid, Jump to, room access
(private, adding a member), creating a room, hiding one, Appearance, guests in an Open Air room, a link to a room,
sharing text in, realtime messages from another user. Not on the device: pinch zoom (adb has no multi-touch), saving
an edit and deleting (both covered by `UiFeaturesTest`), push notifications (no Firebase credentials here).

## 19. Media collections (2026-10-23)

DESIGN.md §31, the last web feature the app lacked, ported from `web/src/collections.ts` and
`web/src/views/collection/lazy.ts`. The server is unchanged.

### 19.1 Data

- Models (`Models.kt`): `MediaCollection` (not `Collection`, which Kotlin already has), `Collections`,
  `CollectionItem`, `CollectionMeta`, `Badge` and `SaveFrom` (a message's file, or an item). `Message.fileSources`
  (`file_sources`, now in `MSG_FIELDS`), and `Message.localItems`, the items a message on its way attaches.
- `ChatApi`: `collections`, `markSeen`, `badges`, `collection`, `createCollection`, `updateCollection`,
  `deleteCollection`, `collectionItems` (60 a page, cursor on `(created, id)`, older or newer), `itemIdsSince`,
  `saveItem`, `uploadItem`, `removeItem`, `savedIn`, `follow`, `itemUrl`, `itemPosterUrl`,
  `subscribeCollections` (yours, your subscriptions, and one topic per collection you follow), `subscribeBadges`
  (the `chat/badges` topic: a collection's id once it is made public or private, renamed or deleted). `NewMessage.items`: a
  JSON list in a JSON body, a JSON string in a form.
- `CollectionsSync` (`repo/`) ports `collections.ts`. It is started with the session for a signed-in user, keeps
  `AppState.collections`, refetches 250 ms after a live change and on every reconnect, and `seen()` clears a badge at
  once.
- The outbox keeps a message's items with it (`Outgoing.items`), so Retry sends the same ids.
- `Badges` (`repo/`), one per room screen: it asks `/api/chat/badges` once per collection while the room is open, in
  batches of at most 50. From the first badge on it listens to `chat/badges` and asks again about the ids it shows (the
  old badge stays until the answer), and about all of them after a reconnect, as on the web: made public, private or
  renamed, a badge follows live.

### 19.2 Screens

| Web | App |
|---|---|
| Sidebar section | The room list's Collections section, after Rooms: yours (a lock when private), then those you follow with their owner and a "99+" badge of new items. Its "+" (and the New button's "New collection") opens `NewCollectionDialog` |
| `/c/:id` | `CollectionScreen` (`feature/room`): name, whose it is, Public or Private, count; month headings; new items ringed with a dot and "*n* new since your last visit", sent as seen while the app is in view; follows the store (items added come in at the top; items taken out elsewhere leave; private or deleted: "This collection doesn't exist."). The owner gets Upload in the bar (the photo picker, several at once, one at a time with the percentage, images and videos of 20 MB at most, a 429 waited out) and Rename, Make public/private and Delete in the menu, plus × on each tile. Others get Subscribe / Unsubscribe |
| Save on a tile, in the viewer | A round collections button on every image and video tile of a message, on every tile of a collection page and in the viewer's bar (signed in only) → `SaveToCollectionSheet` (`core/ui`): tick to save, untick to take out, or make a new private one there |
| Attach from collections | The + menu's "From a collection" (a fourth button next to + would leave the phone's text field too narrow) → `CollectionPickerSheet`: a chip per collection, a grid, at most what the message still takes; the items join the tray after the files |
| The badge | Over a tile from a collection: the name with a lock for your private one, which opens the collection; "Private collection" (not tappable) for someone else's private one; nothing for one that is gone |
| Viewer | `CollectionViewerScreen`: the items around the one opened, oldest first, captioned "Added …" |
| Links | `/c/:id` links open the collection page (`routeOf`, the manifest's App Links) |

The web's drag-and-drop and paste upload have no phone equivalent. Guests see public collections and badges, but
can't save, subscribe or attach.

### 19.3 Tests and checks

`CollectionsTest` (`:core:data`): saving and `/saved` (409 twice, taking it out), paging both ways, the store's list
with live new counts, seen, and a collection turning private, and attaching through the outbox with `file_sources` and
badges for the owner, another user, and a deleted collection. `UiCollectionsTest` (`:app`): making a collection
from the room list and saving a room's image to it; a badge leading another user to a public collection, subscribing,
the room list's "1 new" and the page's "1 new since your last visit" until seen; attaching from the picker and the
sent message's badge; saving and unsaving from the viewer opened on a collection page. `RoutesTest`, `ServersTest`:
`/c/` links. Upload isn't covered: Robolectric can't drive the photo picker.

Robolectric found one problem in sheets. A sheet is its own window, and in tests its coroutines finished on a
background thread, so its state sometimes never reached the screen. The save and picker sheets now run on
`services.main`, as the services do.

67 JVM tests in `:core:data` and 32 in `:app` pass; release lint passes. While here, the viewer's seek bar got the
Media3 opt-in that release lint required. The release APK is 3.53 MB (+0.05 MB; budget 6 MB). Not yet tried on the
emulator.

## 20. Room list folding, unread first, accounts screen (2026-10-23)

- **Folding** (the web's, DESIGN.md §7.1): the Direct messages, Rooms and Collections headings fold their section;
  folded, it lists only the rooms with unread messages (collections you follow with new items). Which sections are
  folded is a device setting (`DeviceSettings.folded`, kept in the accounts index like the theme), as the web keeps it
  in the browser.
- **Unread first**, on the web too: `roomSections` takes the unread counts and lists rooms and DMs with a badge first,
  each group in its usual order (by name, by activity). Prefetch warms them first too.
- **Accounts** moved from the profile to their own screen (`AccountsScreen`, route `AccountList`), opened by tapping the
  brand (logo and title) on the room list (§17.2).
- **Profile order**, as on the web: picture, display name, Appearance, This device, Password, Session (Log out).

Tests: `RoomSectionsTest` (`:core:data`); `UiPortsTest` "unread rooms are listed first, and a folded section lists
only them"; `UiAccountsTest` switches through the brand's account list. All 69 JVM tests in `:core:data` and 34 in
`:app` pass.
