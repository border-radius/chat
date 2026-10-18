# Chat — MVP Design Document

| | |
|---|---|
| **Status** | Draft |
| **Date** | 2026-10-10 |
| **Scope** | MVP (§1–§14); post-MVP features: avatars §15, direct messages §16, attachments §17, unread counts §18, replies §19, reactions and emoji §20, selecting, forwarding and deleting several messages §21, accounts and quality of life §22, room access (private rooms, Open Air rooms and guests) §23, site settings §24, measured scale §25, Telegram bridge §26 |

Code and tests cite this document by section number (e.g. `§7.5`). **Don't renumber sections:** append new ones, and
mark obsolete ones as such instead of deleting them.

---

## 1. Summary

Chat is a small, fast, real-time group chat web app. Users sign up, see a list of public rooms, join one, and talk. New messages show up live without a page reload.

The whole system is **one PocketBase binary**. It handles auth, data, realtime and serving the static frontend. The frontend is **vanilla TypeScript** with no UI framework, bundled by **esbuild** into one small JS file and one CSS file.

## 2. Goals and non-goals

### Goals

1. **Working real-time chat.** Sign up or log in, list and create rooms, read history, and send and receive messages live.
   - Any user can create a room.
   - Each user can hide rooms they don't want to see.
   - Users can edit and delete their own messages. A deleted message leaves a "Message deleted" placeholder in the history.
   - Removing a room **archives** it. Archived rooms stay readable.
   - History is kept forever. A user can scroll back to the very first message in any room.
2. **Minimal and fast frontend.** No framework and no virtual DOM. Strict size budget (§7.7). The page should be interactive in about 1 second on a mid-range phone.
3. **Simple to run.** `npm run dev` gives a working local setup. Deployment is one binary plus a few folders.
4. **Secure by default.** All access control lives in PocketBase API rules. Untrusted text never reaches the page as HTML.
5. **Tested.** Unit, integration and end-to-end tests run in CI on every push.

### Non-goals (MVP)

These are left out on purpose. The design should not block them later.

- Private rooms, room membership or invitations (direct messages: now designed in §16)
- File and image uploads (avatars and attachments: now designed in §15 and §17), link previews
- Reactions, threads, replies, mentions (replies: now designed in §19; reactions: §20)
- Typing indicators, presence, read receipts
- Push notifications, email notifications
- Message search
- OAuth providers (email and password only)
- Email verification (not required to sign up or post, so no SMTP needed)
- Message retention limits (history is never pruned)
- Native mobile apps, offline support (a service worker for an installable app and an offline shell: now §27)
- End-to-end encryption

## 3. Architecture

```
┌────────────────────────── Browser ───────────────────────────┐
│  index.html + app.[hash].js + app.[hash].css                 │
│                                                              │
│  router ─► views (login / rooms / room) ─► dom helpers       │
│              │                                               │
│              ▼                                               │
│            store  ◄──── api.ts (wraps pb.ts, a PB client)    │
└──────────────────────────────┬───────────────────────────────┘
                REST (JSON)    │    SSE (realtime)
┌──────────────────────────────▼───────────────────────────────┐
│                     PocketBase (single binary)               │
│  /api/*         REST + auth + realtime (SSE)                 │
│  /*             static files from pb_public/                 │
│  pb_migrations/ schema as code (JS migrations)               │
│  pb_hooks/      server-side validation, headers              │
│  pb_data/       SQLite DB + backups                          │
└──────────────────────────────────────────────────────────────┘
```

**Why PocketBase:** auth, a REST API, per-record access rules, realtime over SSE, an admin UI, backups and static file serving all come in one Go binary backed by SQLite. That is all an MVP chat needs. It removes the need for a separate API server, WebSocket server, or reverse proxy (PocketBase can also issue its own TLS certificates).

**Why no framework:** the UI has three screens and one hot path, which is appending messages to a list. Updating the DOM directly with a few small helpers is less code, loads faster, and is easy to reason about.

**Version assumption:** the design targets the PocketBase API from **v0.23 onward** (`@request.body` in rules, `$app` and `routerUse` in JS hooks, autodate fields). The exact release is pinned in `scripts/fetch-pocketbase.sh`, using the latest stable release when implementation starts.

## 4. Repository layout

```
chat/
├── docs/
│   ├── DESIGN.md               # this document (the living spec)
│   ├── QA.md                   # QA findings and their fixes, BUG-24 onward (code and tests cite them)
│   ├── REFACTOR.md
│   └── history/                # finished plans: BUILD_PLAN.md (MVP), NEXT_FEATURES_PLAN.md (§15–§17)
├── package.json
├── tsconfig.json, tsconfig.server.json
├── scripts/
│   ├── fetch-pocketbase.sh     # downloads the pinned PB release into ./bin
│   ├── build.mjs               # esbuild production build → pb_public/, size budget (§7.7)
│   ├── dev.mjs                 # esbuild watch + spawns `pocketbase serve`
│   └── pb-types.sh             # PocketBase's generated types for typechecking hooks and migrations
├── pb_migrations/              # schema + API rules (committed; never edited once applied, only added to)
│   ├── 1760000000_init.js
│   ├── 1760000001_qa_fixes.js
│   ├── 1760000002_avatars.js           # §15.1
│   ├── 1760000003_direct_messages.js   # §16.1, §16.3
│   ├── 1760000004_attachments.js       # §17.1
│   ├── 1760000005_file_names.js        # §17.1 (QA BUG-28)
│   ├── 1760000006_room_reads.js        # §18.1
│   ├── 1760000007_replies.js           # §19.1
│   ├── 1760000008_lowercase_emails.js  # QA BUG-47
│   ├── 1760000009_reactions.js         # §20.1
│   ├── 1760000010_fit_thumbs.js        # §17.5
│   ├── 1760000011_forwarding.js        # §21.3
│   ├── 1760000012_accounts.js          # §22.1, §22.2
│   ├── 1760000015_site.js              # §24
│   ├── 1760000017_no_dms.js            # §16.7
│   ├── 1760000018_attachment_limits.js # §17.1
│   ├── 1760000019_telegram.js          # §26 (tg_* collections)
│   └── 1760000020_service_messages.js  # §5.3 (messages.author optional: service messages)
├── pb_hooks/                   # server-side JS hooks (committed)
│   ├── main.pb.js              # registrations only
│   ├── telegram.pb.js          # the Telegram bridge's registrations, only with TELEGRAM_BOT_TOKEN (§26)
│   ├── telegram/               # the bridge: api, people, links, inbound, outbound, worker (§26)
│   └── lib/
│       ├── messages.js         # messages hooks: text, attachments, replies, forwards, soft delete, edit stamps (§5.6, §17, §19, §21)
│       ├── rooms.js            # rooms hooks: names, DM fields, members, archive stamps (§5.2, §16, §23)
│       ├── access.js           # who can see a room: canSee, SEES_SQL, lost-access events (§23)
│       ├── records.js          # shared record helpers: field errors, name keys, uploaded file names
│       ├── text.js             # pure string cleaning: invisible characters, name keys, file names (§5.2, QA BUG-38)
│       ├── http.js             # security + cache headers, /assets/ (§5.6, §8.2)
│       ├── dms.js              # POST /api/chat/dms (§16.2)
│       ├── reads.js            # GET /api/chat/unread, POST /api/chat/reads (§18.2)
│       ├── reactions.js        # POST /api/chat/reactions (§20.2)
│       ├── bulk.js             # POST /api/chat/delete, POST /api/chat/forward (§21)
│       ├── account.js          # POST /api/chat/password (§22.2)
│       ├── site.js             # invite-only signups (§24), GET /manifest.webmanifest (§27)
│       ├── users.js            # users hooks (§5.1, §22.1), login by email, GET /api/chat/users (§16.5)
│       ├── emoji.js            # the emoji a reaction may be (§20.1)
│       └── images.js           # upload image size limit (§15, QA BUG-24)
├── web/
│   ├── index.html              # template; build injects hashed asset names
│   ├── styles/app.css          # @imports styles/app/*.css (one file per part, in cascade order) into one bundle
│   ├── styles/viewer.css       # the image viewer's, loaded on first use (§17.7)
│   ├── public/icons/           # the installed app's icons, copied to pb_public/icons/ (§27)
│   └── src/
│       ├── main.ts             # boot; registers the service worker
│       ├── sw.ts               # the service worker, built on its own to /sw.js (§27)
│       ├── app.ts              # app shell: session, routes, app bar
│       ├── api.ts              # the only module that talks to PocketBase (through pb.ts)
│       ├── pb.ts               # minimal PocketBase client: requests, auth store, realtime (§6)
│       ├── store.ts            # tiny observable state + selectors
│       ├── sync.ts             # keeps rooms + hidden rows live (§7.4)
│       ├── actions.ts          # room commands: create, hide, archive, open DM
│       ├── context.ts, scope.ts, router.ts, dom.ts
│       ├── lib/                # pure logic, unit-tested without a DOM
│       │   ├── id.ts, time.ts, cursor.ts, scroll.ts, limits.ts, types.ts
│       │   ├── messages.ts     # window logic: merge, dedupe, trim, group (§7.5)
│       │   ├── rooms.ts        # DM titles (§16.5)
│       │   ├── avatar.ts       # initials + color (§15.4)
│       │   ├── image.ts        # resize + re-encode before upload (§15.3)
│       │   ├── files.ts        # attachment names and limits (§17)
│       │   ├── emoji.ts        # the picker's emoji, recently used (§20.4)
│       │   ├── reactions.ts    # optimistic reaction changes, who reacted (§20.3)
│       │   └── token.ts        # file token cache (§17.3)
│       ├── ui/                 # small reusable components
│       │   ├── menu.ts, avatar.ts, user-search.ts, emoji-picker.ts
│       └── views/
│           ├── login.ts, rooms.ts, home.ts, profile.ts
│           ├── room.ts         # puts the controller's changes on screen, wires the parts
│           └── room/           # controller.ts (message window, loading, realtime, sending; no DOM),
│                               # header.ts, messages.ts (the list), composer.ts, forward.ts (§21.3),
│                               # viewer.ts (image viewer, a lazy chunk: §17.7)
├── tests/
│   ├── unit/                   # Vitest + happy-dom, against a real throwaway PocketBase
│   ├── integration/            # Vitest against a real PocketBase process
│   ├── e2e/                    # Playwright
│   └── support/                # shared harness and fixtures
├── bin/                        # pocketbase binary (gitignored)
├── pb_public/                  # build output (gitignored)
└── pb_data/                    # local DB (gitignored)
```

## 5. Data model

All schema is defined in `pb_migrations/` so every environment gets the same schema and API rules. Changes made in the admin UI during development are captured with PocketBase's automigrate and committed.

### 5.1 `users` (built-in auth collection)

| Field | Type | Notes |
|---|---|---|
| `id` | text (15) | PB default |
| `email` | email | unique, required; `emailVisibility = false` |
| `name` | text | required, 1–32 chars, trimmed |
| `created` / `updated` | autodate | |

### 5.2 `rooms`

| Field | Type | Notes |
|---|---|---|
| `id` | text (15) | |
| `name` | text | required, 1–48 chars, **unique** ignoring case in any script (via `name_key`) |
| `name_key` | text, hidden | set by a hook: the name without invisible characters, NFKC-normalized and case-folded; unique index. Never returned by the API. |
| `created_by` | relation → users | required, single |
| `archived` | bool | default `false` |
| `archived_at` | date | set by a hook when `archived` changes; cleared on unarchive |
| `created` / `updated` | autodate | |

Rooms are **never hard-deleted** through the API. "Delete room" in the UI sets `archived = true`. An archived room:

- is **read-only**: no new messages, edits or deletes (enforced by API rules, §5.5);
- keeps its full history, which anyone can still read;
- keeps its name reserved, because the unique index still applies;
- can be unarchived by its creator.

### 5.3 `messages`

| Field | Type | Notes |
|---|---|---|
| `id` | text (15) | **may be client-supplied** (see §7.5) |
| `room` | relation → rooms | required, single, cascade delete (applies only to a superuser hard-delete from the admin UI) |
| `author` | relation → users | single; required of every request (the create rule), empty only for a **service message** (below) |
| `text` | text | max 2000 chars. Must be non-empty unless the message is deleted (enforced by a hook, §5.6), so not marked `required` in the schema. |
| `edited_at` | date | empty = never edited; set by a hook when `text` changes on update |
| `deleted` | bool | default `false`; once true it can never be set back to false |
| `deleted_at` | date | set by a hook when `deleted` becomes true |
| `created` / `updated` | autodate | |

**Messages are soft-deleted.** When a user deletes a message, the record stays in place. The server sets `deleted = true`, stamps `deleted_at` and **clears `text`**, so the content really is gone from the database and from every API response.

Clients render a deleted message as a *"Message deleted"* placeholder, with its author and time kept. This keeps conversations readable, so replies still make sense and history doesn't silently shrink. A deleted message can't be edited or undeleted.

The API `DELETE` endpoint is turned off, so records are never removed. The only exception is a superuser using the admin UI.

**Service messages** are the app's own notices in a room, such as "Telegram group "Friends" was disconnected from this room." (§26.5): a message with no author, only text. Only server code makes one (`postService` in `pb_hooks/lib/messages.js`, in a room that isn't archived): the create rule requires `author = @request.auth.id` from a signed-in caller, and no update rule matches an empty author, so nobody can make, edit or delete one through the API (`pb_migrations/1760000020_service_messages.js`). They can't be replied to, reacted to or forwarded (the hooks refuse it), count as unread like anyone else's message, aren't passed on to Telegram, and show as a centered grey line with their time and no buttons. A room opened at its first unread message goes to it when that is a service message, as for any other.

**Indexes:** `CREATE INDEX idx_messages_room_created ON messages (room, created, id)`. This supports history pagination in both directions (§7.5) and the realtime filter. Because `id` is part of the index, the `(created, id)` cursor stays stable even when two messages share the same millisecond.

### 5.4 `hidden_rooms`

This collection records which rooms each user has hidden. There is one row per (user, room) pair. Hiding a room is personal, so other users are unaffected.

| Field | Type | Notes |
|---|---|---|
| `user` | relation → users | required, cascade delete |
| `room` | relation → rooms | required, cascade delete |
| `created` | autodate | |

**Indexes:** `UNIQUE (user, room)`.

A hidden room:

- disappears from the user's main room list;
- appears under a collapsed **"Hidden rooms"** section, where it can be unhidden;
- stays reachable by direct link `/r/:id`, and posting still works there.

A separate collection was chosen over a multi-relation field on `users` for three reasons. The access rules stay trivial. The `users` record doesn't grow without bound. Hide and unhide are single insert or delete operations, so two tabs can't overwrite each other's changes.

### 5.5 API rules

`@auth` below means `@request.auth.id != ""`.

| Collection | list / view | create | update | delete |
|---|---|---|---|---|
| `users` | `@auth` (other users' email stays hidden) | public (signup, no verification) + `NO_PUBLIC_EMAIL`¹ | `id = @request.auth.id && NO_PUBLIC_EMAIL`¹ | **none** (superuser only)² |
| `rooms` | `@auth` | `@auth && @request.body.created_by = @request.auth.id && (@request.body.archived:isset = false \|\| @request.body.archived = false) && @request.body.archived_at:isset = false` | `created_by = @request.auth.id && @request.body.created_by:isset = false && @request.body.archived_at:isset = false` | **none** (superuser only) |
| `messages` | `@auth` | `@auth && @request.body.author = @request.auth.id && @request.body.room.archived = false && @request.body.deleted:isset = false && @request.body.deleted_at:isset = false && @request.body.edited_at:isset = false` | `author = @request.auth.id && room.archived = false && deleted = false && @request.body.author:isset = false && @request.body.room:isset = false && @request.body.edited_at:isset = false && @request.body.deleted_at:isset = false && (@request.body.deleted:isset = false \|\| @request.body.deleted = true)` | **none** (superuser only) |
| `hidden_rooms` | `user = @request.auth.id` | `@auth && @request.body.user = @request.auth.id` | **none** | `user = @request.auth.id` |

¹ `NO_PUBLIC_EMAIL` = `(@request.body.emailVisibility:isset = false || @request.body.emailVisibility = false)`. Users can't make their email visible to others.

² Users can't delete their own account: their rooms reference them through a required relation, and a hook refuses deleting anyone who wrote a message (`messages.author` isn't required, for service messages, §5.3, so PocketBase would otherwise clear it and their words would read as the app's), so the delete could only fail for anyone who had posted. Removing an account (and deciding what happens to its content) is a superuser task for now.

The source of truth for all rules is `pb_migrations/1760000000_init.js` and the migrations after it. Direct messages (§16.3) change the `rooms` and `messages` rules above; this table is the MVP version.

PocketBase applies the list rule to realtime subscriptions too, so these rules also control who receives SSE events.

In plain terms:

- Any logged-in user can create a room.
- Only the creator can rename, archive or unarchive it.
- Only the author can edit or delete a message, and only while its room is active. "Delete" is an update that sets `deleted: true`. After that the message is frozen.
- `hidden_rooms` rows are visible only to their owner.

### 5.6 Server hooks (`pb_hooks/main.pb.js`)

The hooks are kept small. They only do things the rules can't express:

- **Normalize text:** trim `messages.text`, `rooms.name` and `users.name` on create and update, and reject values that are empty after trimming or made only of invisible characters (zero-width spaces, bidi controls, BOM…). Names also lose bidi overrides and zero-width spaces, so they can't be used to spoof another name. Message text keeps tabs and line breaks (stored as `\n`: CR LF, a lone CR and U+2028/2029 become one) and loses every other control character (NUL, bell, escape codes from pasted terminal output; QA BUG-105). The one exception is message text on a delete (next bullet).
- **Unique room names:** on `rooms` create and update, set `name_key` and reject a name whose key another room already has (`validation_not_unique` on `name`, like the index error it replaces).
- **Soft delete:** on a `messages` update where `deleted` becomes true:
  - set `deleted_at = now` and `text = ""`;
  - ignore any other fields in the same request;
  - leave `edited_at` unchanged.
- **Edit stamp:** on a `messages` update where `text` actually changed (and it isn't a delete), set `edited_at = now`. An update that doesn't change the text leaves it untouched.
- **Archive stamp:** on a `rooms` update, set `archived_at = now` when `archived` becomes true, and clear it when `archived` becomes false.
- **Archived-room guard (defense in depth):** reject a message create, update or delete when the target room is archived. This repeats the API rule in case rule traversal through `@request.body.room.archived` behaves differently in the pinned PocketBase version. Integration tests cover both layers.
- **Security headers** via `routerUse`: every response gets `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. Static app paths also get `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The CSP is *not* applied to `/api/*` or to the admin UI `/_/`, which sends its own CSP.
- **Cache headers:** `/assets/*` (content-hashed) gets `Cache-Control: public, max-age=31536000, immutable`. Every other static path, including `/` and `index.html`, gets `no-cache`.
- **No `index.html` for a missing asset or API:** PocketBase serves `index.html` for any path that isn't a file (§7.1). Under `/assets/` (a route of ours, `GET /assets/{path...}`) a missing file is a 404 with `Cache-Control: no-store` instead: an old build's lazy chunk, asked for by a tab left open across a deploy, would otherwise get HTML (useless as a script) cached for a year under its hashed name. An unknown `/api/` path is a JSON 404 too, not the app's page.
- **Rate limiting:** PocketBase's built-in limiter, enabled from the init migration. The limits are per client IP:
  - `messages:create`: 10 requests per 5 s.
  - `users:create` (guests): 20 requests per 60 s.
  - `messages:update` (edits and soft deletes): 20 requests per 10 s.
  - `rooms:create`: 5 requests per 60 s (rooms can't be deleted, so a flood would stay in everyone's list).
  - PocketBase's default rules are kept after these.

  Test harnesses turn the limiter off, because every test client shares 127.0.0.1. `http.test.ts` turns it back on to verify the 429.

## 6. API usage (frontend ↔ backend)

The frontend talks to PocketBase through `pb.ts`, a minimal client (about 2 KB gzipped) that replaced the official **PocketBase JS SDK** (about 10 KB, most of it admin services, OAuth2/OTP/MFA flows and cookie helpers the app never used; §13). It keeps the SDK 0.28 wire behavior the app relies on: JSON or multipart requests with the auth header, `pb.filter()` binding, the auth record in `localStorage` under the SDK's key `pocketbase_auth` (shared with other tabs through the `storage` event), and the realtime protocol (one `EventSource`, `PB_CONNECT` client id, subscriptions POSTed to `/api/realtime` and resent after reconnects with the same backoff). Only `api.ts` imports it. The record calls in the table below are named as in the SDK; `api.ts` implements them on top of `pb.send()`. The tests still use the SDK as an admin client.

| Action | Call |
|---|---|
| Sign up | `users.create({email, password, passwordConfirm, name})` then `authWithPassword` |
| Log in | `users.authWithPassword(email, password)` |
| Restore session | `pb.authStore.isValid` → `users.authRefresh()` in the background |
| Log out | `pb.authStore.clear()` + unsubscribe all |
| List rooms | `rooms.getFullList({sort: "name", fields: "id,name,archived,created_by"})` |
| List my hidden rooms | `hidden_rooms.getFullList({fields: "id,room"})` (fetched in parallel with rooms) |
| Create room | `rooms.create({name, created_by: me})` |
| Archive / unarchive room | `rooms.update(id, {archived: true \| false})` |
| Hide room | `hidden_rooms.create({user: me, room})` |
| Unhide room | `hidden_rooms.delete(hiddenRowId)` |
| Latest page | `messages.getList(1, 50, {filter: pb.filter("room = {:r}", {r}), sort: "-created,-id", skipTotal: true, expand: "author", fields: MSG_FIELDS})` |
| Older page (scroll up) | same, filter `room = {:r} && (created < {:c} \|\| (created = {:c} && id < {:i}))` using the oldest loaded message as the cursor |
| Newer page (scroll down after jumping back) | filter `room = {:r} && (created > {:c} \|\| (created = {:c} && id > {:i}))`, sort `created,id` |
| One message (open `/r/:id/m/:msgId`) | `messages.getOne(id, {expand: "author", fields: MSG_FIELDS})`, then an older and a newer page around it |
| First page ("jump to beginning") | filter `room = {:r}`, sort `created,id` |
| Send | `messages.create({id, room, author: me, text}, {expand: "author"})` |
| Edit | `messages.update(id, {text}, {expand: "author"})` |
| Delete (soft) | `messages.update(id, {deleted: true})` → the response has `text: ""`, `deleted: true` |
| Live room | `messages.subscribe("*", cb, {filter: pb.filter("room = {:r}", {r}), expand: "author", fields: MSG_FIELDS})` handles `create` and `update` (edits and soft deletes). A `delete` event only happens if a superuser hard-deletes a record, and it is handled by removing the message. |
| Live room list | `rooms.subscribe("*", cb)` (new rooms, renames, archive) + `hidden_rooms.subscribe("*", cb)` (keeps hide state in sync across tabs) |

`MSG_FIELDS = "id,room,text,created,updated,edited_at,deleted,author,expand.author.id,expand.author.name"`. Fetching only these fields keeps payloads small and never pulls user emails.

Pagination always uses **keyset cursors** on `(created, id)`, never page numbers, and passes `skipTotal: true`. Every page is a single index range scan, so it costs the same whether the room has 100 messages or 10 million. New inserts never shift page boundaries.

Filters are always built with `pb.filter()` and never by string concatenation, which prevents filter injection.

## 7. Frontend design

### 7.1 Screens and routes (paths)

| Route | View | Notes |
|---|---|---|
| `/login`, `/signup` | login / signup (tabbed form) | guests only (§23.3); `/me` redirects here without a session. Until §23 every route did. |
| `/` | room list + "new room" form, with a greeting where a room would be | on narrow screens only the room list shows |
| `/r/:roomId` | room: message list + composer | on wide screens the room list stays visible as a sidebar |
| `/r/:roomId/m/:msgId` | room, opened at a specific message (window centered on it) | used by "jump to beginning" and shareable later |

**The room list has three sections:**

1. **Rooms:** active rooms that aren't hidden, sorted by name.
2. **Hidden rooms:** collapsed by default and shown with a count. Each row has an "Unhide" action.
3. **Archived:** collapsed by default. Rooms here are read-only and still browsable.

A room hidden by the user that is also archived appears only under Archived.

**The room header menu (⋯) has three actions:**

- **Hide room** (or **Unhide**), for everyone.
- **Archive room** (or **Unarchive**), for the creator only, behind an inline confirm.
- **Jump to beginning**.

An archived room shows a banner, "This room is archived. History is read-only.", and replaces the composer with that banner.

Pages are paths (`/r/abc`), not hashes. PocketBase serves `index.html` for any path that isn't a file (`serve --indexFallback`, on by default), with the same headers as `/` (§5.6), so a page opened directly or reloaded works with no server-side routes. The router (`router.ts`) changes pages with the History API: `navigate()` pushes an entry, `popstate` (Back, Forward) is followed, and a plain left click on a link to one of the routes is taken over (no page load); a click asking for a new tab or window, a link with `target` or `download`, and links elsewhere (files under `/api/`, other sites) are left to the browser. Old-style links (`/#/r/abc`, from when the app used hashes) still work: on start, or when one is opened in a running tab (`hashchange`), the URL is replaced by its path. A trailing slash (`/r/abc/`) is the same page. The app learns where the user went (to return there after logging in) from the router's `onNavigate`, called before any redirect. It matches the path against a small route table, calls the current view's `unmount()`, then calls the next view's `mount(el, params)`. When the next route uses the same view factory and the mounted view has `update(params)`, the router calls that instead. The room page uses this to swap only the room pane, so the sidebar stays mounted while switching rooms.

### 7.2 View contract

```ts
interface View {
  mount(root: HTMLElement, params: Record<string, string>): void;
  unmount(): void; // remove listeners, unsubscribe realtime, abort fetches
  update?(params: Record<string, string>): void; // optional: take new params without a remount
}
```

Each view owns a `Scope` (`scope.ts`): an `AbortSignal` that every `addEventListener` call receives, plus `defer()`/`sub()` for store listeners and realtime subscriptions, so `unmount()` is `scope.dispose()`. After every `await`, async work checks `scope.active`. Views are single-use: the router and the sidebar layout create a fresh one for every mount. Both room menus (row and header) are `ui/menu.ts`, a `<details>` disclosure with an optional inline confirm step. It owns its focus handling.

Logged-in views receive a `Ctx` (`context.ts`): `{ api, store, sync, actions, navigate }`. They render from the store and change data through `actions` (`actions.ts`: create, hide, unhide, archive). Only the room view subscribes to anything itself, and only to its own room's messages.

### 7.3 DOM helpers (`dom.ts`)

```ts
h("div", {class: "msg", dataset: {id}}, [h("b", {}, name), text]) // returns HTMLElement
```

- Children that are strings become **text nodes**. There is no `innerHTML` anywhere in the codebase, and a lint check enforces this (§9.5). This is the main defense against XSS.
- No reactivity system. Views update the DOM directly in response to store events.

### 7.4 State (`store.ts`)

This is a typed event emitter around a plain object: `{ user, rooms: Map, hidden: Map<roomId, hiddenRowId>, roomsStatus, activeRoomId }`. Updates such as `upsertRoom(r)` and `markHidden(roomId, rowId)` live next to the store and replace maps rather than mutating them. `sync.ts` owns `rooms`, `hidden` and `roomsStatus` while someone is logged in: it loads both lists, holds the only `rooms` and `hidden_rooms` subscriptions, and reloads after each reconnect. A reload's answer is older than whatever changed in the store while it was out (live events, and what this tab did itself: a room created, a DM opened, a room hidden or shown, which may have no event yet), so while a reload is out, `sync.ts` notes every room (and every hidden row) that changes in the store, and its answer takes those from the store as it is then, or leaves them out if gone (QA BUG-69, BUG-107). The selector `roomSections(state)` splits rooms into Rooms, Hidden and Archived. It is a pure function and is unit-tested. Message lists are **not** kept in global state. Each room view owns its own `MessageList` model (§7.5) and throws it away on unmount, which keeps memory bounded. Only each room's latest page outlives it, in IndexedDB (§7.5, room cache).

### 7.5 Message list (hot path)

**Requirement:** a user can scroll back to the first message of any room, however long its history is, and the page must stay fast. Rendering every message would make the DOM grow without bound, so the list is a **sliding window** over the history, with keyset cursors at both ends.

The list logic is written as **pure functions** in `lib/messages.ts` so it can be tested without a DOM:

- `merge(win, incoming[]) → win` keeps the window sorted by `(created, id)` and dedupes by `id`. When the same id arrives twice, the version with the later `updated` wins, which handles edits.
- `remove(win, id)`.
- `trim(win, side, max) → {win, dropped}` drops messages from the far end of the window.
- `group(win)` places consecutive messages by the same author within 5 minutes under one header.

The window model is:

```ts
interface MessageWindow {
  items: Message[];      // sorted (created, id), at most WINDOW_MAX (300)
  hasOlder: boolean;     // false ⇒ items[0] is the room's very first message
  hasNewer: boolean;     // false ⇒ window is at the live edge
}
```

**Scrolling behavior:**

| Event | Behavior |
|---|---|
| Open room | Load the latest page (50 messages). `hasNewer = false`. Scroll to the bottom. |
| Top sentinel visible (`IntersectionObserver`) | Fetch the older page by cursor and prepend it. If the window is now over 300 messages, trim from the **bottom** and set `hasNewer = true`. An older page with fewer than 50 messages sets `hasOlder = false` and shows a "Beginning of #room" marker. |
| Bottom sentinel visible while `hasNewer` | Fetch the newer page by cursor and append it, trimming from the **top** and setting `hasOlder = true`. A newer page with fewer than 50 messages sets `hasNewer = false`, which means the window is back at the live edge. |
| "Jump to beginning" | Reset the window to the first page (`hasOlder = false`, `hasNewer = true`) and scroll to the top. |
| "Jump to latest" pill | Reset the window to the latest page and scroll to the bottom. |
| Realtime `create` at the live edge (`!hasNewer`) | Append the message. Auto-scroll only if the user was within 80 px of the bottom; otherwise show "↓ New messages". |
| Realtime `create` while scrolled into history (`hasNewer`) | **Don't append.** The window doesn't hold the messages in between, so appending would leave a gap. Show "↓ New messages · Jump to latest" instead. |
| Realtime `update` (edit or soft delete) | Apply it only if the id is in the window: replace the text, or swap in the placeholder. Otherwise ignore it, because the next fetch will return the current version. |

Each message the user sees is loaded once per visit. Moving the window costs one indexed query of 50 rows, and the DOM never holds more than about 300 messages.

The window state machine above lives in `views/room/controller.ts`, which has no DOM. It reports each change with a hint (render, keep the anchor, scroll to the bottom/top/target), and `views/room.ts` applies that hint to the list.

**DOM rendering (`views/room.ts`, `views/room/messages.ts`):**

- `Map<id, HTMLElement>` gives O(1) update and removal.
- Pages are prepended or appended inside a `DocumentFragment`, and trimmed nodes are removed in one pass. The list is never fully re-rendered.
- **Scroll anchoring:** before prepending, trimming the top, or trimming the bottom, record an anchor element and its `offsetTop`, then restore the scroll position from it afterwards. The visible content must never jump. Native CSS `overflow-anchor` is also enabled.
- **Concurrency:** at most one fetch runs per direction. A stale response is discarded if the window was reset (by a jump or a room change) while it was in flight, using a generation counter.

**Optimistic send with client ids:**

1. The client generates a PocketBase-valid id (15 chars, `[a-z0-9]`, via `crypto.getRandomValues`).
2. The message is inserted immediately with `pending` state (dimmed).
3. `create()` is called with that id.
4. Whichever arrives first, the `create()` response or the realtime `create` event, **replaces** the pending entry by id. The second one is a no-op because of the dedupe.
5. On error the entry is marked `failed` with a **Retry** button that reuses the same id, so a retry can never create a duplicate.
6. Sends go to the server one at a time, in the order they were made: the server orders messages by when it saves them,
   so a slow one (a large attachment) must not be overtaken by the next (QA BUG-71). A message's edits, deletes and
   reactions go one at a time too (QA BUG-72).
7. A send that fails after its room view has gone (another room was opened meanwhile) is kept, and the room's next view
   shows it as failed, with Retry (QA BUG-76).

**Reconnects:** the client (`pb.ts`) reconnects SSE automatically. On every `PB_CONNECT` after the first, the room view checks where its window is:

- **At the live edge:** it fetches *newer than the newest loaded message* (by cursor, repeating until a short page comes back) and merges the results in. This fills the gap from the disconnect, however long it was.
- **Scrolled into history:** it fetches nothing newer, because the next newer-page fetch picks up the missed messages naturally.

In both cases it also refetches the messages *already in the window* that changed while it was disconnected (`updated` later than the newest `updated` it holds), so edits and deletes missed meanwhile apply: a deleted message must never keep showing its text. Sync refetches the room record, in case the room was archived meanwhile.

If the room's first load fails (other than "room not found"), the list shows an error with **Retry** instead of an empty history, the composer is hidden, and the load is retried by itself on the next reconnect.

**Room cache (`cache.ts`):** switching rooms, and reloading the page, shows the room at once, as it was last time,
while its first page loads.

- **What is kept:** per room, in IndexedDB (database `chat`, store `rooms`, keyed by room id), the latest page
  (at most 50 saved messages, never pending or failed ones), whether there is older history and the room record,
  tagged with the user it was loaded for ("" for a guest). Saved a second after the window last changed, when the view
  goes and when the page is left (`pagehide`: a reload, the tab closed; QA BUG-97; written at once and committed, QA BUG-104), and only while the window is at the
  live edge, fresh (not itself from the cache) and the user is still the one it was loaded for: after a logout or a
  user switch nothing more is written. A room that turns out not to be there (not found, or gone from the loaded room
  list: access lost, §23.4) is saved empty, so it isn't shown again (QA BUG-98); so is any kept room that leaves the
  loaded room list while the app is open, open or not (`forgetGone`, QA BUG-101).
- **Shown:** on opening a room without a message in the route, if the cache answers before the first page. Nothing
  else is waited for, except a file token when the kept messages have attachments (§17.3): the room is in the room
  list, or, before the list is in (a reload), the kept room record stands in for it in the store until the list
  replaces it. A room that a loaded list lacks waits for the server's answer (so access you have lost isn't shown,
  §23.4). What you send, edit or react to while it shows stays when the page comes: the page was asked for before,
  and realtime may not have told the room yet (QA BUG-100); a kept copy no newer than the page's gives way to it, so an author's new name or avatar shows (QA BUG-103). A reconnect meanwhile does nothing: the page is on its way. The window is `stale` until the page is in: the page
  then replaces it (pending sends are kept as usual), staying where you scrolled unless you were at the bottom;
  realtime events received meanwhile are replayed on top of it; and loading older history waits for it. What it shows
  counts as read (§18.3), up to its newest message, except while it shows at the bottom before the server has said
  where the unread messages start (after a reload): they may start further up (QA BUG-102); leaving before the page is in, the unread counts are fetched again
  rather than taken as zero, since the server may have had more. A first load that fails still shows the error and **Retry**, not the stale window.
- **Prefetched** (`prefetch.ts`): the unread events of other rooms carry no text (§18.3), so when a room's unread count
  goes up (a live message, or the counts loaded at start), its latest page is fetched in the background and kept, and
  opening it shows the new messages at once. A message deleted in another room refetches it too, so the cache doesn't
  show the deleted text when the room is next opened (QA BUG-95; a delete made while the app was closed still shows
  until the first page is in). The fetches start a second after the first count goes up, and messages meanwhile join
  them: a busy room is fetched about once a second and never puts the others off (QA BUG-92). Rooms are fetched one
  at a time, 250 ms apart, and a refused fetch (the rate limit, offline) ends the run: hundreds of rooms with unread
  messages at login must not use up the per-IP request limit (QA BUG-94). The open room is left alone (it gets every
  message live and keeps its own page). Once the room list is in, the rooms not kept yet (the first 30 it lists: DMs,
  then rooms) are fetched the same way after those, so a room never opened on this device opens at once too. Only
  while someone is logged in; stopped before the cache is cleared when the session ends.
- **In memory** too, what was kept since the page loaded: switching back to a room shows it in the same task as the
  click, without waiting for IndexedDB (and without an empty room for a frame). Without IndexedDB, that is all there is.
- **Cleared** whenever the session ends (logout, another user, a guest logging in), as drafts are (§22.3). A room kept
  for another user is never shown, even if a clear was missed. Without IndexedDB (a private window) nothing is kept.

### 7.6 Composer

- `<textarea>` that grows automatically up to 6 lines. **Enter** sends and **Shift+Enter** inserts a newline.
- The send button is disabled when the trimmed text is empty or over 2000 characters. A counter appears after 1800 characters.
- Input is kept on failure, so nothing the user typed is lost.
- Message text is rendered with `white-space: pre-wrap`. No markdown in the MVP.
- **Up arrow** in an empty composer starts editing the user's most recent message in the current window. Deleted messages are skipped.

### 7.6.1 Editing messages

- **Starting an edit:** hovering your own message (or long-pressing it on touch screens) shows **Edit** and **Delete**. The Up-arrow shortcut also starts an edit (§7.6).
- **Edit mode:** the message text is replaced in place by a textarea pre-filled with the current text. **Enter** saves, **Esc** cancels, and Shift+Enter inserts a newline. Saving unchanged text is a no-op and makes no request.
- **Optimistic save:** the new text shows immediately. If the save fails, the old text comes back and an inline error appears with a Retry option.
- **"(edited)" label:** shown after the time when `edited_at` is set. Its tooltip gives the edit time.
- **Edits by others:** these arrive as realtime `update` events and replace the message text in place. The scroll position stays anchored.
- **Archived rooms:** Edit and Delete are hidden, and the server rejects them anyway.
- **No edit time limit** in the MVP. Earlier versions of a message are not stored.

### 7.6.2 Deleting messages

- **Delete** asks for an inline confirm: the row shows "Delete this message? **Delete** / Cancel", since browser `confirm()` isn't used.
- **Optimistic delete:** the message is swapped for the placeholder right away. If the request fails, the original text comes back with an inline error.
- **Placeholder:** the author name and time stay. The body shows *"Message deleted"* in muted italics, with no actions and no "(edited)" label. It takes part in author grouping like any other message.
- **Pending or failed sends** (never stored on the server) are simply removed from the list. They don't leave a placeholder.
- **Deletes by others** arrive as realtime `update` events and swap in the placeholder in place. The scroll position stays anchored.

### 7.6.3 Links in messages

- **What becomes a link:** `http://` and `https://` URLs, and `www.` addresses (opened over https), found in the text by
  `linkify()` (`lib/links.ts`). Nothing else: `javascript:`, `data:` and the like stay text, and each link is checked
  with `new URL`. The link shows the text as written.
- **Where it ends:** at whitespace or `<`, `>`, `"`. Punctuation that ends a sentence (`. , : ; ! ? ' " * _ … 。`) is left
  out, as are typographic quotes (`“ ” ‘ ’ « »`, as phones type them: Unicode Pi/Pf), and so is a closing `)` or `]` the link didn't open: in "(see https://en.wikipedia.org/wiki/Rust_(language))" the link
  keeps its own pair.
- **Opening:** in a new tab (`target="_blank" rel="noopener noreferrer nofollow"`), even a link to a page of the app
  (the router leaves `target` links alone, §7.1). Text still only ever reaches the page as text nodes (§7.3): a link
  is an `<a>` made with `h()` around a text node.
- **Not inside other words:** a `www.` right after `@`, `.` or `-` (`bob@www.example.com`, `my.www.example.com`) isn't
  linked.
- Under the message, a line per link with its favicon and title (§28).
- Only message bodies: reply quotes are buttons (a link can't go in one), and the edit box shows the raw text.

### 7.7 Performance budget (enforced in CI, §9.4)

| Asset | Budget (gzipped) |
|---|---|
| `app.js` (including the PocketBase client) | **≤ 43.25 KB** (25 KB for the MVP; raised for §15–§17, §19, §22, §23, §24, video attachments, the QA pass 8 and 9 fixes, bigger attachments, audio attachments, §27, the room cache and its prefetching, opening at the first unread message, the QA pass 11 fixes, service messages, the room cache without waiting for the network, the QA pass 12 fixes, prefetching rooms not yet kept, the QA pass 13 fixes, thumbnail caching, the QA pass 14 fixes, Ctrl+Up/Down to pick the reply, link previews, the room access dialog fix, who can post, see §13) |
| `app.css` | **≤ 6.20 KB** (5 KB until §21, 5.5 KB until §23, 6 KB until audio attachments, 6.05 KB until §18.5, 6.10 KB until §28, 6.15 KB until the room access dialog fix, see §13) |
| `index.html` | ≤ 1.5 KB |
| Image viewer (§17.7), loaded on first use | ≤ 4 KB script, ≤ 1.5 KB stylesheet |
| Web fonts | **none** (system font stack) |
| Requests on first load | 3 (html, js, css) + API; the manifest, its icons and `sw.js` (§27) come after, off the critical path |

Other rules:

- `<script type="module" defer>` in the `<head>` and `<link rel="stylesheet">`. No render-blocking third-party code.
- An inline app shell in `index.html` paints before the JS runs.
- The latest-messages fetch and the SSE subscribe start in parallel.
- `Intl.DateTimeFormat` instances are created once and cached.
- A feature most visits never use can be a lazy chunk (`import()`, esbuild code splitting) with its own budget, like
  the image viewer (§17.7). A lazy module must not import a module `app.js` uses: esbuild would move it into a shared
  chunk that `app.js` loads on every visit (a fourth request). The build fails if `app.js` imports any chunk; such a
  module gets what it needs from `app.js` as arguments.

### 7.8 Styling

- One plain CSS file with custom properties for theming.
- `prefers-color-scheme` light and dark themes.
- Mobile-first layout using flexbox and grid. The sidebar collapses below 720 px.
- Accessibility basics:
  - Semantic HTML (`<main>`, `<nav>`, `<form>`, `<ol>` for messages).
  - The message list has `aria-live="polite"`.
  - Visible focus rings and full keyboard operability.
  - Color contrast of at least 4.5:1.

## 8. Build and dev tooling

### 8.1 Dependencies

| Package | Kind | Purpose |
|---|---|---|
| `pocketbase` | dev | JS SDK, only for tests (admin and raw-API clients); the app uses `web/src/pb.ts` |
| `esbuild` | dev | bundling and minification |
| `typescript` | dev | type checking only (`tsc --noEmit`) |
| `vitest`, `happy-dom` | dev | unit and integration tests |
| `@playwright/test` | dev | e2e tests |

Nothing else. The PocketBase **binary** is not an npm package. `scripts/fetch-pocketbase.sh` downloads the pinned version for the current OS and architecture into `bin/` and checks its SHA-256.

### 8.2 `scripts/build.mjs`

```js
await esbuild.build({
  entryPoints: { app: "web/src/main.ts", "app.css": "web/styles/app.css" },
  bundle: true, minify: true, sourcemap: "linked",
  format: "esm", target: "es2022",
  entryNames: "assets/[name]-[hash]", outdir: "pb_public",
  metafile: true, legalComments: "none",
});
// (plus code splitting for lazy chunks, and web/styles/viewer.css built first: its hashed name is defined
//  into the app's build as VIEWER_CSS, §17.7 — see scripts/lib/build-utils.mjs)
// then: read metafile → rewrite web/index.html with hashed names → pb_public/index.html
// then: exit 1 if app.js imports a shared chunk (§7.7)
// then: print gzipped sizes; exit 1 if over budget (§7.7)
```

### 8.3 npm scripts

| Script | Does |
|---|---|
| `setup` | `scripts/fetch-pocketbase.sh` |
| `dev` | esbuild in watch mode (unminified, inline sourcemaps) writing to `pb_public/`, plus `bin/pocketbase serve --dev`. Reload the browser by hand (live reload is not part of the MVP). |
| `build` | production build (§8.2) |
| `typecheck` | `tsc --noEmit` (`strict`, `noUncheckedIndexedAccess`) |
| `test` | unit tests |
| `test:int` | integration tests |
| `test:e2e` | build, then run Playwright |
| `check` | typecheck + test + test:int + build (what CI runs before e2e) |

## 9. Testing strategy

| Layer | Tool | What it covers | Speed |
|---|---|---|---|
| Unit | Vitest + happy-dom + real PocketBase (temp dir) | pure logic, DOM helpers, views against the real API | ~5 s |
| Integration | Vitest + real PocketBase (temp dir) | migrations, API rules, hooks, realtime, `createApi` | ~40 s (serial) |
| E2E | Playwright (Chromium; Firefox and WebKit in CI) | golden user flows through the real built app | ~30 s |
| Budget | build script | bundle size limits | in `build` |

### 9.1 Unit tests (`tests/unit/`)

View tests run against a real, throwaway PocketBase (temp data dir) using the real `createApi`. There is no fake backend to drift from the server. Failures, latency and reconnects are injected with `vi.spyOn` wrappers over the real client (`tests/support/api.ts`). Large histories are seeded straight into the test DB.

**`lib/messages.test.ts`**
- `merge` keeps the list sorted by `(created, id)`, including for out-of-order input and for messages with the same `created` value.
- `merge` dedupes by id, and the incoming (server) version replaces the `pending` one.
- `merge` keeps the newer `updated` version, so an edit wins over a stale copy.
- `merge` of an older page prepends correctly. Merging an empty page is a no-op.
- `trim("bottom", 300)` on 350 items drops the newest 50 and sets `hasNewer`. `trim("top")` mirrors this and sets `hasOlder`.
- `remove` of an unknown id is a no-op.
- `group` splits on author change and on a gap of more than 5 minutes, and does not split at exactly 5:00.
- Cursor builder: produces the correct `(created, id)` filter strings for older and newer pages, built with `pb.filter` parameters.

**`store.test.ts`**
- `roomSections`: hidden rooms go to Hidden, archived rooms go to Archived (even when also hidden), and the rest go to Rooms, sorted by name.

**`lib/id.test.ts`**
- Ids are 15 chars and match `/^[a-z0-9]{15}$/`.
- 10,000 generated ids contain no collisions.

**`lib/time.test.ts`**
- Shows "today" vs. a date label.
- Uses a fixed timezone through `TZ`.

**`dom.test.ts`**
- `h()` sets attributes, dataset and children.
- **A string child containing `<img src=x onerror=…>` becomes a text node and creates no element.**

**`router.test.ts`**
- Matches routes and extracts params.
- Unknown paths redirect to `/`.
- Unauthenticated access redirects to `/login`.
- `unmount` of the previous view is called before the next view's `mount`.
- A trailing slash is the same page.
- An image viewer history entry with no viewer open (§17.7) is passed over with `history.back()`, on start and on `popstate`.

**`views/room/*.test.ts`** (real PocketBase; one file per feature, sharing `views/room/harness.ts`)
- Initial render shows 50 messages, oldest at the top.
- Optimistic send shows a pending message straight away. The server ack clears the pending state, and a later realtime echo does **not** duplicate it.
- When send fails, the message shows as failed with a Retry button. Retry calls `create` again with the **same id**.
- An incoming realtime message while scrolled up shows the "new messages" pill and does not auto-scroll.
- **Deleting:**
  - Delete → confirm calls `update(id, {deleted: true})`, and the message becomes a placeholder showing the author, the time and "Message deleted".
  - Cancel makes no request.
  - On failure the original text is restored.
  - A realtime `update` with `deleted: true` from another user swaps in the placeholder.
  - Placeholders have no Edit or Delete actions.
  - Deleting a failed or pending send removes it from the list without a request.
- A realtime `delete` event (superuser hard delete) removes the element.
- `unmount()` calls unsubscribe and aborts pending requests, and no listeners remain.
- Composer: Enter sends, Shift+Enter adds a newline, and whitespace-only or over-length text is blocked.
- **Windowing**, with 1,000 seeded messages:
  - Repeatedly triggering the top sentinel eventually reaches message #1 and shows "Beginning of #room".
  - The DOM never holds more than 300 messages.
  - No message is duplicated or skipped across the whole scroll.
- Scrolled into history (`hasNewer`): a realtime `create` is **not** appended, and the "Jump to latest" pill appears. Clicking it resets the window to the latest page.
- "Jump to beginning" loads the first page and hides the top sentinel.
- A stale page response that arrives after a jump is discarded.
- **Editing:**
  - Edit shows a prefilled textarea. Enter calls `update`, and the "(edited)" label appears once the server responds.
  - Esc restores the original text with no request.
  - On a failed save the old text is restored and an error is shown.
  - Up arrow in an empty composer edits the user's last own message.
  - Edit and Delete are not shown on other users' messages.
- **Archived room:** the banner is shown, there is no composer, and there are no Edit or Delete actions.

**`views/rooms.test.ts`** (real PocketBase)
- The three sections render. Hide moves a room to Hidden (calling `hidden_rooms.create`) and Unhide moves it back.
- The Archive action is visible only to the creator and needs a confirm.
- A realtime room `update` with `archived: true` moves the room to Archived.

**`views/login.test.ts`**
- Validation errors from the server are shown.
- Successful login navigates to `/`.

### 9.2 Integration tests (`tests/integration/`)

A Vitest `globalSetup` does the following:

1. Creates a temp dir.
2. Runs `bin/pocketbase superuser upsert` and `bin/pocketbase serve --http 127.0.0.1:<free port> --dir <tmp>/pb_data --migrationsDir pb_migrations --hooksDir pb_hooks`.
3. Waits for `/api/health`.
4. Provides the URL to the tests, and kills the process and removes the dir on teardown.

Each test file creates fresh users through a helper, so tests don't depend on each other's data.

**Schema and migrations**
- All three collections exist with the expected fields and indexes.
- Migrations apply cleanly to an empty DB, and running them a second time is a no-op.

**Auth and rules: `messages`**
- An anonymous user cannot list, view or create messages (403 or an empty list).
- User A can create a message with `author = A`.
- User A **cannot** create a message with `author = B` (400 or 403).
- User B cannot delete or update A's message. User A can edit and delete their own.
- **Soft delete:**
  - `update({deleted: true})` returns `deleted: true`, `text: ""` and `deleted_at` set.
  - The record still appears in list results, so pagination stays continuous.
  - A raw DB read confirms the old text is gone.
  - Sending `{deleted: true, text: "x"}` still results in empty text.
  - A deleted message rejects further edits and `{deleted: false}` (undelete).
  - A client cannot set `deleted_at` directly or create a message already deleted.
  - The `DELETE` endpoint is rejected for every user, including the author.
  - Deleting does not set `edited_at`.
  - A subscriber receives the soft delete as an `update` event.
- Editing text sets `edited_at`. An update with unchanged text leaves `edited_at` empty. A client cannot set `edited_at` directly.
- User A cannot move a message to another room or change its author by update.
- Text over 2000 chars, or whitespace-only text, is rejected (hook plus field rule), both on create and on edit.
- A client-supplied id is accepted. Reusing an existing id is rejected, which is what makes Retry safe.

**Auth and rules: `rooms` and archiving**
- Any authenticated user can create a room. Creating a room with `created_by` set to someone else, or created already archived, is rejected.
- A duplicate room name, including one that differs only in case, is rejected. This includes the name of an archived room.
- Only the creator can rename, archive or unarchive a room. Archiving sets `archived_at`, and unarchiving clears it.
- The `DELETE` endpoint on rooms is rejected for every user, including the creator.
- An archived room cannot be renamed into another room's name, and a new room cannot take an archived room's name. Names are never reused.
- In an archived room, message create, edit and delete are all rejected, including for the room creator. List and view still work. After unarchiving, posting works again.

**Auth and rules: `hidden_rooms` and `users`**
- User A can hide a room for themselves. Hiding a room for user B (`user = B`) is rejected.
- Hiding the same room twice is rejected by the unique index.
- User B listing `hidden_rooms` never sees A's rows.
- A can unhide (delete) their own row, and B cannot delete A's row.
- Signing up works without email verification, and the new user can post immediately.
- Listing users as an authenticated user never returns other users' `email`.

**History and pagination**
- Seed 1,000 messages in one room, including several that share the same `created` value.
- Walking the room with older-page cursors from the latest page returns all 1,000 exactly once, in order, ending at the very first message.
- Walking the room with newer-page cursors from the first page gives the same result.
- `EXPLAIN QUERY PLAN` for the cursor query uses `idx_messages_room_created` and does not scan the whole table.

**Realtime**
- B subscribes to room R1 with a filter. When A posts in R1, B receives a `create` event with `expand.author.name`. When A posts in R2, B receives **nothing** within 500 ms.
- An anonymous subscriber receives no message events.
- A delete produces a `delete` event for subscribers.

**Hooks and headers**
- `GET /` returns the CSP and `nosniff` headers.
- `/assets/app-*.js` returns `immutable` cache headers, and `index.html` returns `no-cache`.
- A missing `/assets/` file is a 404 with `no-store`, an unknown `/api/` path a JSON 404; app pages still get `index.html`.
- Rate limit: the 11th message within 5 seconds returns 429.

### 9.3 End-to-end tests (`tests/e2e/`)

Playwright's `webServer` starts the built app on a fresh PocketBase with a temp data dir (the same helper as §9.2).

1. **Signup to first message:** sign up, see the empty room list, create "general", send "hello", and see it rendered with the user's name.
2. **Realtime between two users:** two browser contexts, A and B, are in the same room. A sends a message and B sees it within 1 second without reloading. B deletes their own message, and A sees it turn into a "Message deleted" placeholder that keeps B's name and the time. After a reload the placeholder is still there.
3. **Full history:**
   - Seed 2,000 messages through the API. The newest 50 are shown.
   - Scrolling up keeps loading without the view jumping, until "Beginning of #room" and message #1 are visible.
   - The DOM stays at or below 300 messages throughout.
   - Scrolling back down reaches the live edge, and a message B sends then appears live.
   - "Jump to beginning" in the menu shows message #1 directly.
4. **Edit message:** A edits their message and B sees the new text plus "(edited)" live. Up arrow in an empty composer opens the last message for editing.
5. **Hide and unhide:** A hides "random". It disappears from A's list and appears under Hidden, while B's list is unaffected. Opening it by URL still works. Unhide restores it.
6. **Archive:**
   - The creator archives the room. Both A and B see it move to Archived, and the composer is replaced with the read-only banner.
   - History can still be scrolled to the beginning.
   - A user who is not the creator sees no Archive action.
   - Unarchive brings the composer back.
7. **Session persistence:** reloading the page keeps the user logged in. Logging out redirects to `/login`, and going back does not show room content.
8. **Reconnect gap fill:** take B offline with `context.setOffline(true)`, have A send 80 messages (more than one page), bring B back online, and all 80 appear in order.
9. **XSS smoke test:** sending `<img src=x onerror=window.__pwned=1>` renders as literal text and `window.__pwned` stays undefined. The same holds after editing.
10. **Mobile viewport (390×844):** the room list collapses, the composer is visible above the keyboard area, and sending works.

### 9.4 Non-functional checks

- **Bundle budget:** the build fails if the limits in §7.7 are exceeded.
- **Accessibility:** run `@axe-core/playwright` on the login, rooms and room screens, with zero serious or critical violations (this adds a dev dependency only).
- **Performance smoke test (optional in CI):** Playwright with 4× CPU throttling. The time from navigating to `/r/:id` until the first message is visible should be under 1.5 s on a local server.

### 9.5 Static checks

- `tsc --noEmit` in strict mode.
- A grep check in CI fails if `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` appear in `web/src`.

### 9.6 CI (GitHub Actions)

The CI job:

1. `npm ci`
2. `npm run setup` (cached by PocketBase version)
3. `npm run check`
4. `npx playwright install --with-deps`
5. `npm run test:e2e`

Playwright traces are uploaded when a test fails. The job runs on every push and pull request.

## 10. Security considerations

| Threat | Mitigation |
|---|---|
| XSS through message, room or user names | Rendered with text nodes only. No `innerHTML` (enforced in CI). Strict CSP with no inline scripts. |
| Impersonation (posting as someone else) | `@request.body.author = @request.auth.id` create rule. Author can't change on update. Covered by integration tests. |
| Deleted content lingering | Soft delete wipes `text` on the server inside the same update. Only the placeholder metadata (author, time) remains, and an integration test checks the DB row directly. |
| Filter injection | `pb.filter()` with bound params everywhere. |
| Email harvesting | `emailVisibility = false`, and `fields` requests never include email. |
| Spam and flooding | PocketBase rate limits, the 2000-char cap, and signup rate limiting. The limits are per client IP: behind a reverse proxy, `TRUSTED_PROXY=X-Forwarded-For` (applied on start by `trustProxy` in `http.js`, set in the Docker image) makes them per client rather than one for everyone; the rightmost address is used, so clients can't choose theirs. |
| Server-side request forgery (link previews) | The previews worker fetches only http(s) on default ports from public-looking hosts (§28.1): no local names, private IPv4, IPv6 literals or userinfo. Names aren't resolved, so DNS pointing inward or a redirect still gets through, and only a title and a small icon are kept. `LINK_PREVIEWS=off` turns it off. |
| Filling the disk | Uploads are capped per file, per message and by the message rate limit; forwards copy nothing (§21.3). |
| Token theft | The token is stored in `localStorage` by the client (`pb.ts`). The CSP greatly lowers XSS risk. Moving to HttpOnly cookies is noted as future work. |
| Admin UI exposure | Strong superuser password. In production, optionally restrict `/_/` by IP using a hook. |

## 11. Deployment

Deployment artifacts are `bin/pocketbase`, `pb_public/`, `pb_migrations/` and `pb_hooks/`.

- Run under systemd with `pocketbase serve chat.example.com`, which issues a Let's Encrypt certificate automatically. Alternatively, run it behind an existing reverse proxy.
- Migrations run automatically on start.
- Use PocketBase's built-in scheduled backups (Settings → Backups), stored locally or in S3-compatible storage.
- Uploaded files (avatars, attachments; §15, §17) live in `pb_data/storage` (or S3-compatible storage set in PocketBase's settings) and are included in backups, so plan disk space for them.
- Scale target for the MVP: a single node. SQLite in WAL mode easily handles thousands of concurrent SSE clients and hundreds of messages per second at this size.

## 12. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M1 | Skeleton: repo layout, fetch script, esbuild build and dev scripts, empty app served by PB | `npm run dev` serves "hello" and `npm run build` passes the budget |
| M2 | Schema, rules and hooks, plus the integration test suite | all §9.2 tests green |
| M3 | Auth screens, router, store, DOM helpers, with unit tests | log in and out works and unit tests are green |
| M4 | Rooms list: create, hide/unhide, archive/unarchive, realtime room list | §9.1 rooms tests green |
| M5 | Room view: windowed history to the beginning, realtime, optimistic send, edit, soft delete with placeholder, archived read-only mode | §9.1 room tests green |
| M6 | Polish: styles, dark mode, mobile, accessibility, CSP and cache headers | axe clean |
| M7 | E2E suite, CI pipeline, deploy notes | CI green on main |

## 13. Decisions and open questions

### Decided (2026-10-10)

| Topic | Decision |
|---|---|
| Room creation | Any logged-in user can create a room. |
| Unwanted rooms | Each user can hide rooms for themselves only (§5.4). |
| Hidden rooms and new activity | A hidden room stays completely silent: no badge, no count, no notification. |
| Email verification | Not required. |
| Message editing | Authors can edit their own messages, with no time limit. Edited messages show "(edited)". |
| Message deletion | Soft delete. The text is wiped on the server, and a "Message deleted" placeholder keeps the author and time. Deletion is final, with no undelete. |
| Room deletion | Rooms are archived, not deleted. Archived rooms are read-only and keep their full history. |
| Who can archive | Only the room creator can archive or unarchive. |
| Archived room names | The name stays reserved forever and is never reused (unique index covers archived rooms). |
| Retention | History is kept forever. Every room can be scrolled back to its first message (§7.5). |

### Decided (2026-10-10, post-MVP features)

| Topic | Decision |
|---|---|
| Build order | Avatars (§15), then direct messages (§16), then attachments (§17). Each ships on its own. Attachments come last because they must respect DM privacy. |
| DM model | A DM is a `rooms` record with `kind = "dm"` and exactly two `members`, so the message list, windowing, realtime, edit and delete code is reused unchanged (§16.1). |
| Creating a DM | Only through the get-or-create route `POST /api/chat/dms`, never through the `rooms` API (§16.2). |
| Who can DM whom | Any logged-in user can DM any other user. No blocking in this round. No DMs with yourself. |
| Closing a DM | Reuses `hidden_rooms`. A new message in the DM reopens it for the recipient (§16.4). |
| Avatar storage | The built-in `users.avatar` file field: public, raster images only (no SVG), always displayed through thumbnails (§15.1). |
| Attachment access | `protected` file field: downloads need a short-lived file token and pass the message's view rule, so DM files stay private (§17.3). |
| Attachment layout | Images render at a fixed height, so loading them never moves the scroll position (§17.5). |
| Attachment aspect ratio | Images keep their aspect ratio, uncropped: fixed height, width from the image, capped (a too-wide image is narrowed and letterboxed in its fixed-height box rather than shortened, §17.5). |
| Metadata stripping | The client re-encodes JPEG/PNG/WebP images (PNG as PNG, the rest as JPEG) before upload, which drops EXIF (including GPS). Best effort, protecting honest users only (§15.3). |
| Bundle budget | `app.js` budget raised from 25 KB to 30 KB gzipped (§7.7): avatars + DMs measured 25.9 KB. One bundle, no lazy chunks. |
| Bundle budget (replies) | `app.js` budget raised from 30 KB to 32 KB gzipped (§7.7): replies (§19) took it to 30.8 KB. |

### Decided (2026-10-11, unread counts)

| Topic | Decision |
|---|---|
| Which rooms | Every room in the Rooms and Direct messages sections. Hidden and archived rooms still show nothing (§13 above), and neither does the room you are in. |
| What the badge shows | A count, shown as `99+` past 99. Your own messages and deleted messages never count. |
| Where read state lives | On the server (`room_reads`, §18.1), so it follows you across tabs and devices. |
| When a room is read | When the room view shows its latest messages, scrolled to the bottom, in a visible tab (§18.3). Scrolled up, new messages stay unread until you scroll down to them. |
| Before you joined | Messages older than your account never count, so a new user doesn't start with 99+ everywhere. |

### Decided (2026-10-11, bundle size)

| Topic | Decision |
|---|---|
| PocketBase SDK | Replaced in the app by `web/src/pb.ts` (§6): the SDK builds every service in its constructor, so none of its unused code could be tree-shaken. `app.js` went from 31.1 KB to 23.1 KB gzipped; the 32 KB budget (§7.7) is unchanged. Same storage key, so existing sessions survive the switch. |

### Decided (2026-10-11, reactions and emoji)

| Topic | Decision |
|---|---|
| How many | Any number of different emoji per person per message; each one once (clicking it again takes it back). |
| Which emoji | Exactly the picker's set (§20.4, about 600, Emoji 12 and older), checked by the server. This bounds what a message can collect without a per-message cap, and every current system font shows them all. |
| Where they live | On the message (`messages.reactions`, §20.1), not in a collection of their own: they travel with the message through pages, realtime, reconnect refetches and the window's merge logic, with nothing new on the client's read path. |
| Who can react | Anyone who can see the message, on any saved message that isn't deleted, in a room that isn't archived. Your own messages too. |
| Picker | Categories and a "Recent" row (per browser, `localStorage`), no search: names for ~600 emoji would cost about as much again as the emoji themselves. |

### Decided (2026-10-11, selecting, forwarding and deleting several messages)

| Topic | Decision |
|---|---|
| What can be selected | Any saved message that isn't deleted, yours or not; at most 50 at a time (`MAX_SELECTED`). Forwarding works on any of them, archived rooms included; deleting only when every selected message is yours and the room isn't archived (§21.1). |
| One request, all or nothing | Deleting or forwarding several messages is one request to a route that runs in one transaction (§21.2, §21.3), not one request per message: the per-message rate limits would refuse a large selection halfway, and a half-done delete or forward is harder to explain than a failed one. |
| What a forward is | A new message by the forwarder that points at the original (`forward_of`) and shows it as it is now, saying who first wrote it (`forwarded_from`, kept through forwards of forwards). Nothing is copied: copies of the attachments let one account fill the disk (50 messages × 32 MB per request, 20 requests a minute). An edit of the original shows in its forwards and a delete empties them; the view rule lets a forward's readers see that one original, nothing else of its room (§21.3). Replies and reactions are not forwarded. Forwards made before this hold copies. |
| Where to | Any room or DM you can write in, or someone you have no DM with yet (found by name, which opens one). Afterwards the view goes to where the messages went. |
| CSS budget | `app.css` raised from 5 KB to 5.5 KB gzipped (§7.7): §21 took it to 5.15 KB. |

### Decided (2026-10-12, accounts and quality of life)

| Topic | Decision |
|---|---|
| Unique display names | Compared like room names (case, width and invisible characters ignored), backed by a unique index. Accounts that already shared a name keep it; nobody else can take it (§22.1). |
| Changing the password | Needs the current one; signs out every other session. The tab that changed it stays logged in (§22.2). |
| Where Log out is | On the profile page, not in the app bar (§22.2). |
| Drafts | Kept in `localStorage` per user and room, as you type; cleared when the session ends (§22.3). |
| Bundle budget (§22) | `app.js` budget raised from 32 KB to 34 KB gzipped (§7.7): §22 took it to 32.9 KB. |

### Decided (2026-10-12, room access)

| Topic | Decision |
|---|---|
| Levels | Private (members only), Public (signed in; the default) and Open Air (anyone can read, signed-in users post) (§23). Only the creator changes them. |
| Field | A new `visibility` next to `kind`, not more `kind` values: `kind` still says room or DM, which half the rules and the UI branch on. DMs are `private`. |
| Members | `rooms.members`, as for DMs, up to 100. Dropped when a room stops being private, so an old list never comes back by surprise, and guests never see who was in it. |
| Guests | Read Open Air rooms that aren't archived, with authors' names and avatars and attachments; nothing else. The app starts on the guest view, not the login screen. |
| Losing access | Pushed as a realtime `delete` by a rooms hook (PocketBase sends changes only to those who can still see them). |
| Private room names | Still unique among all rooms, as before: creating a room under a private room's name says it is taken. Accepted (the name is all it gives away), like most chat apps. |
| Bundle budget (§23) | `app.js` raised from 34 KB to 37 KB and `app.css` from 5.5 KB to 6 KB gzipped (§7.7): §23 took them to 35.7 KB and 5.7 KB. |

### Decided (2026-10-12, image viewer)

| Topic | Decision |
|---|---|
| Viewer loading | A lazy chunk plus its own stylesheet (§17.7), not an iframe: same savings for `app.js`, without a second document, cross-frame focus handling or relaxing `frame-ancestors`. `app.js` stays within its 37 KB budget (+0.2 KB). |
| Which images | Every image in the room's message window, oldest first, taken when the viewer opens. |

### Decided (2026-10-12, URLs)

| Topic | Decision |
|---|---|
| Paths, not hashes | Pages are paths (`/r/abc`) (§7.1). PocketBase already serves `index.html` for any path that isn't a file, so no server change for pages (a missing asset or an unknown `/api/` path gets a 404 instead, §5.6); anything put in front of it (a proxy or CDN serving `pb_public/` itself) must do the same. Old `#/` links are rewritten to their path, so bookmarks and shared links keep working. `app.js` +0.2 KB. |

### Decided (2026-10-12, site settings)

| Topic | Decision |
|---|---|
| Where | A `site` collection with one record, edited in the PocketBase admin UI: no admin pages in the app. A collection, not PocketBase's own settings, because the logo is a file and the invite code must stay hidden (a hidden field). |
| One code | One shared invite code, not one per person: what was asked for, and changing it is how an admin stops it working. Per-person invites (an `invites` collection, used up on signup) can come later without changing the rest. |
| Closed signups | Invite-only with an empty code closes signups altogether, rather than letting anyone in by mistake. |
| Favicon | Stays the app's speech bubble with its unread badge: the logo is any image, which an SVG favicon can't embed. |
| Bundle budget (§24) | `app.js` raised from 37 KB to 38 KB gzipped (§7.7): §24 took it to 37.6 KB. |
| Bundle budget (videos) | `app.js` raised from 38 KB to 39 KB gzipped (§7.7): video attachments (§17.5) and the viewer paging through the whole room (§17.7) took it to 38.1 KB, after merging the image and video tiles. The paging itself lives in the lazy viewer chunk. |
| Bundle budget (QA pass 8) | `app.js` raised from 39 KB to 39.25 KB gzipped (§7.7): the fixes of QA pass 8 (sends and edits in order, failed sends kept after leaving a room, realtime retrying a failed first connect, …) took it to 39.15 KB. |
| Bundle budget (bigger attachments) | `app.js` raised from 39.35 KB to 39.80 KB gzipped (§7.7): uploads through XHR for their progress bar, the "+N" tile and `no_dms` (§16.7, §17) took it to 39.76 KB. |
| Bundle budget (audio attachments) | `app.js` raised from 39.80 KB to 40.05 KB and `app.css` from 6 KB to 6.05 KB gzipped (§7.7): audio players in messages (§17.5) took them to 40.03 KB and 6.01 KB. |
| Bundle budget (§27) | `app.js` raised from 40.05 KB to 40.10 KB gzipped (§7.7): registering the service worker (§27) took it to 40.06 KB. |
| Bundle budget (room cache) | `app.js` raised from 40.10 KB to 40.60 KB gzipped (§7.7): keeping each room's latest messages in IndexedDB (`cache.ts`, §7.5) took it to 40.57 KB. |
| Bundle budget (prefetching) | `app.js` raised from 40.60 KB to 40.85 KB gzipped (§7.7): fetching the latest page of rooms with unread messages into the room cache (`prefetch.ts`, §7.5) took it to 40.80 KB. |
| Bundle budget (first unread) | `app.js` raised from 40.85 KB to 41.15 KB and `app.css` from 6.05 KB to 6.10 KB gzipped (§7.7): opening a room at its first unread message, with the "New" line (§18.5), took them to 41.09 KB and 6.09 KB. |
| Bundle budget (QA pass 11) | `app.js` raised from 41.15 KB to 41.20 KB gzipped (§7.7): the fixes of QA pass 11 (prefetching paced and never put off, deleted messages refetched into the room cache, a room opened before the unread counts are in still opening at its first unread message) took it to 41.17 KB. |
| Bundle budget (service messages) | `app.js` raised from 41.20 KB to 41.30 KB gzipped (§7.7): service messages (§5.3), drawn as a line of their own, took it to 41.25 KB. |
| Bundle budget (cache without waiting) | `app.js` raised from 41.30 KB to 41.50 KB gzipped (§7.7): showing the room cache without waiting for the network (after a reload, with unread messages) and asking for the latest page beside the first unread message (§7.5, §18.5) took it to 41.46 KB. |
| Bundle budget (QA pass 12) | `app.js` raised from 41.50 KB to 41.65 KB gzipped (§7.7): the room cache fixes of QA pass 12 (BUG-97 to BUG-100) took it to 41.58 KB. |
| Bundle budget (room switching) | `app.js` raised from 41.65 KB to 41.75 KB gzipped (§7.7): prefetching the rooms not kept yet and holding the room cache in memory (§7.5) took it to 41.71 KB. |
| Bundle budget (QA pass 13) | `app.js` raised from 41.75 KB to 41.90 KB gzipped (§7.7): the room cache fixes of QA pass 13 (BUG-101 to BUG-104) took it to 41.87 KB. |
| Bundle budget (thumbnail caching) | `app.js` raised from 41.90 KB to 41.95 KB gzipped (§7.7): deleting the service worker's thumbnail cache when a session ends (§27.2) took it to 41.92 KB. |
| Bundle budget (QA pass 14) | `app.js` raised from 41.95 KB to 42.05 KB gzipped (§7.7): the QA pass 14 fixes (BUG-106, then BUG-107) took it to 42.03 KB. |
| Bundle budget (reply stepping) | `app.js` raised from 42.05 KB to 42.25 KB gzipped (§7.7): Ctrl+Up / Ctrl+Down to move the reply between messages (§19.3) took it to 42.21 KB. |
| Bundle budget (link previews) | `app.js` raised from 42.25 KB to 42.40 KB and `app.css` from 6.10 KB to 6.15 KB gzipped (§7.7): link previews (§28) took them to 42.38 KB and 6.13 KB. |
| Bundle budget (room access dialog) | `app.js` raised from 42.40 KB to 42.55 KB and `app.css` from 6.15 KB to 6.20 KB gzipped (§7.7): the access dialog (§23.2) scrolling its body, search results as toggles, and Telegram stand-ins left out took them to 42.52 KB and 6.18 KB. |
| Bundle budget (who can post) | `app.js` raised from 42.55 KB to 43.25 KB gzipped (§7.7): choosing who can post (§23.6), with a second people list in the access dialog, the reader banner and the checks behind replying, editing and forwarding, took it to 43.21 KB. |
| Bundle budget (QA pass 9) | `app.js` raised from 39.25 KB to 39.35 KB gzipped (§7.7): the forwarding fixes of QA pass 9 (messages deleted meanwhile left out, the server's reason shown, focus kept while selecting) took it to 39.30 KB. |

### Still open

1. ~~**Unread state for DMs.**~~ Done for every room: §18.
2. **Upload quotas.** Rate limits cap the request rate, not stored bytes. A per-user storage cap (a hook summing file sizes) is deferred until real usage shows the need.

## 14. Future work (post-MVP)

Blocking users, link previews, typing and presence (custom realtime channels via `$app.subscriptionsBroker()`), OAuth2 providers, message search (SQLite FTS5 through a custom route), and HttpOnly cookie auth. (The service worker: §27.)

---

## Post-MVP features

Sections 15–17 extend the MVP. They follow the same principles: access control lives in API rules (with hooks as
defense in depth), no `innerHTML`, no new runtime dependencies, and the size budget (§7.7) still applies. The
implementation plan (finished) is [`history/NEXT_FEATURES_PLAN.md`](history/NEXT_FEATURES_PLAN.md).

**Shared rules for every uploaded file (§15, §17):**

- **No SVG, no HTML from the upload pipeline into the page.** Images are shown only through PocketBase thumbnails
  (`?thumb=`), which PocketBase re-encodes as raster images. Files are never inlined, fetched as text or parsed.
- **Files are served from `/api/files/…` with a sandbox CSP.** PocketBase already sends
  `Content-Security-Policy: default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox` for files.
  The headers hook (§5.6) adds `X-Content-Type-Options: nosniff` (it already does, for every response), and an
  integration test pins both headers, so an uploaded `.html` can never run script on our origin.
- **The app CSP (§5.6) gains `blob:` in `img-src`,** for previews of files that are not uploaded yet
  (`URL.createObjectURL`). Every object URL is revoked when its message is sent, removed or unmounted.
- **Images keep fixed dimensions in the layout** (`width`/`height` attributes plus CSS), with `loading="lazy"` and
  `decoding="async"`. A late-loading image must never change the height of a message, or scroll anchoring (§7.5)
  breaks.
- **Client-side re-encoding (§15.3)** shrinks and strips metadata before upload; the server limits are the real
  enforcement.
- **At most 25 megapixels per image.** PocketBase decodes a whole image to thumbnail it, so a small, highly
  compressed file declaring huge dimensions would exhaust server memory (QA BUG-24: an 875 KB PNG of 30000×30000 took
  4.6 GB). The avatar and message create hooks read the header of every PNG, JPEG, GIF and WebP upload
  (`pb_hooks/lib/images.js`) and reject larger images, or images whose dimensions can't be found in the first
  256 KB, with `validation_image_too_large`.

## 15. Avatars

### 15.1 Data model

PocketBase's built-in `users` collection already has an `avatar` file field. A migration configures it:

| Setting | Value |
|---|---|
| `maxSelect` | 1 |
| `maxSize` | 2 MB |
| `mimeTypes` | `image/jpeg`, `image/png`, `image/webp`, `image/gif` (**not** `image/svg+xml`) |
| `thumbs` | `48x48`, `96x96` (center crop; 2× for high-DPI screens) |
| `protected` | `false`: avatars are public, and the random filename suffix PocketBase adds keeps them unguessable |

The `users` update rule already limits writes to the owner. Uploading a new file replaces the old one, and
PocketBase deletes the old file from storage. Removing the avatar is `update(id, {avatar: null})`.

### 15.2 API usage

| Action | Call |
|---|---|
| Set avatar | `users.update(me, formData{avatar: File})` |
| Remove avatar | `users.update(me, {avatar: null})` |
| Change display name | `users.update(me, {name})` (the hook already cleans names, §5.6) |
| Avatar URL | `pb.files.getURL(user, user.avatar, {thumb: "48x48"})`, built only in `api.ts` and exposed as `avatarUrl(user, size)` |

`MSG_FIELDS` gains `expand.author.avatar`, and `User` gains `avatar: string` (the filename, `""` when unset). The
logged-in user's own record already contains it.

**Staleness:** messages carry the author's avatar from when they were fetched. A user who changes their avatar is
seen with the new one on the next page load, window move or reconnect. This is accepted. Subscribing to `users`
would push every profile change to every client for little benefit.

### 15.3 Client-side image preparation (`lib/image.ts`)

Before upload, `prepareImage(file, maxEdge)` decodes the image with `createImageBitmap`, scales it so the longest
edge is at most `maxEdge` (512 px for avatars, 2048 px for attachments), and re-encodes it, PNG as PNG (keeps
transparency) and everything else as JPEG, through `OffscreenCanvas.convertToBlob`, falling back to a `<canvas>` element where
`OffscreenCanvas` is missing. Re-encoding drops EXIF, so photos never leak GPS location.

- Not WebP: PocketBase can't write WebP, so a WebP's thumbnails would be PNGs, often bigger than the image itself
  (QA BUG-26). PNG and JPEG are thumbnailed in kind.
- GIFs are uploaded as they are (re-encoding would drop the animation).
- If decoding fails, the original file is uploaded unchanged, and the server limits decide.
- The function is pure apart from the browser image APIs, and unit-testable with a stubbed `createImageBitmap`.

### 15.4 Rendering

- **Fallback:** a user without an avatar gets a circle with their initials. The initials are the first letters of
  the first two words of the name, by grapheme (`Intl.Segmenter`, so emoji and combining marks don't break). The
  background color is one of 8 palette colors picked by a hash of the user **id**, not the name, so it survives
  renames. Both live in `lib/avatar.ts` and are pure. Every palette color passes 4.5:1 contrast with white text in both themes.
- **Message list:** the avatar (32 px, `48x48` thumb, or `96x96` on high-DPI screens via `srcset`) sits next to
  the author header of each group (§7.5 `group`). Continuation messages get none. The image has `alt=""` because the
  author name is right next to it.
- **App bar:** the user's own avatar (24 px) next to their name. Both open `/me`.
- A failing avatar image (`error` event) swaps itself for the initials circle.
- `messageNode`'s signature cache (§7.5 DOM rendering) includes the avatar filename, so a changed avatar re-renders.

### 15.5 Profile view (`/me`)

A new route and view (`views/profile.ts`): the avatar with **Change** (file picker, also accepts drag-and-drop)
and **Remove**, plus the display name with **Save**.

- Picking a file shows a local preview right away (object URL), then uploads the prepared image. On failure the
  previous avatar comes back with the error text inline.
- Client-side checks mirror the server: type in the allowlist, size ≤ 2 MB after preparation. Limits live in
  `lib/limits.ts` with the others, and `schema.test.ts` checks they match the migration.
- On success the store's `user` is replaced with the response, so the app bar updates.

### 15.6 Tests

- **Integration:** the field settings match §15.1; an SVG or a 3 MB file is rejected; user B cannot change A's
  avatar; the thumb URL returns an image; removing the avatar deletes the file (its old URL returns 404); a message
  list includes `expand.author.avatar` and still no email.
- **Unit:** initials (one word, emoji, combining marks, empty name); color is stable for an id and differs across
  ids; `prepareImage` scaling math and GIF passthrough; profile view upload success, failure rollback and remove;
  the message group header shows the image, and initials on `error`.
- **E2E:** A uploads an avatar on `/me`; B sees it next to A's next message. Axe check on `/me`.

## 16. Direct messages

### 16.1 Data model

A DM is a room. This reuses everything the room view already does (windowing, realtime, optimistic send, edit,
soft delete, reconnect gap-fill) without a second code path. New `rooms` fields:

| Field | Type | Notes |
|---|---|---|
| `kind` | select (`public`, `dm`) | required; existing rooms are backfilled to `public` by the migration |
| `members` | relation → users, `maxSelect` 2 | empty for public rooms; exactly the two participants for a DM (sorted by id) |
| `dm_key` | text, hidden | set by the route (§16.2): the two user ids sorted and joined with `:`. Unique index where `dm_key != ''`, so a pair can only ever have one DM. Being hidden, it is also ignored when a regular user sends it to the API. |
| `last_message_at` | date | DMs only: set by a hook on every message create in the room, used to sort the DM list (§16.5) |

`name` stays required for public rooms only. The schema field becomes optional and the rooms hook enforces it
when `kind = "public"`; for DMs it forces `name = ""` and skips the uniqueness check (`name_key` is `""`, which the
partial unique index already ignores). The MVP's `idx_rooms_name` (case-insensitive unique `name`) becomes partial
(`WHERE name != ''`) for the same reason. A DM's title is computed on the client from the other member's name.

DMs are never archived or renamed, and they have no creator-only actions. `created_by` is set to the user who
opened the DM, for consistency only.

**Why not a separate collection:** `messages.room` would have to become a relation to one of two collections, and
every message query, rule, hook and view would grow a branch. With `kind` + `members`, the only real changes are
the access rules and the sidebar. The same two fields later give private group rooms (more than two members).

### 16.2 Opening a DM: `POST /api/chat/dms`

A custom route in `pb_hooks` (`routerAdd`, behind `$apis.requireAuth("users")`). Body: `{ "user": "<id>" }`.

1. Reject a missing, unknown or own user id (400).
2. Compute `dm_key` from the two sorted ids.
3. If a room with that `dm_key` exists, return it (200).
4. Otherwise create it (`kind: "dm"`, `members: [me, other]`, `created_by: me`) with `$app.save` and return it
   (200). If two requests race, the unique index rejects the second insert; the route catches that and returns the
   room the first one created.
5. Delete the caller's `hidden_rooms` row for that room, if any, so reopening a closed DM brings it back.

The route returns the room in the same shape as the `rooms` API (`ROOM_FIELDS` plus the expanded members), so the
client can `upsertRoom` it directly. It is idempotent; the client still calls it only for a DM it doesn't already
have open in its room list (QA BUG-30), since the route is rate limited: `POST /api/chat/dms` 10 per 60 s per IP.

Creating a DM through the `rooms` API is impossible: the create rule (§16.3) only accepts `kind = "public"`.

### 16.3 API rules

`MEMBER` below means `members.id ?= @request.auth.id`.

| Collection | Rule | New value |
|---|---|---|
| `rooms` | list / view | `@auth && (kind = "public" \|\| MEMBER)` |
| `rooms` | create | MVP rule `&& @request.body.kind = "public" && @request.body.members:isset = false && @request.body.dm_key:isset = false && @request.body.last_message_at:isset = false` |
| `rooms` | update | MVP rule `&& kind = "public" && @request.body.kind:isset = false && @request.body.members:isset = false && @request.body.dm_key:isset = false && @request.body.last_message_at:isset = false` |
| `messages` | list / view | `@auth && (room.kind = "public" \|\| room.members.id ?= @request.auth.id)` |
| `messages` | create | MVP rule `&& (@request.body.room.kind = "public" \|\| @request.body.room.members.id ?= @request.auth.id)` |
| `messages` | update | unchanged: only the author can edit, and the author was a member when they posted. Membership never changes for DMs. |
| `hidden_rooms` | create | MVP rule `&& (@request.body.room.kind = "public" \|\| @request.body.room.members.id ?= @request.auth.id)`: nobody can hide (and so probe) a DM they aren't in |

Because PocketBase applies the list rule to realtime subscriptions, a non-member never receives a DM's room or
message events, even with a `"*"` subscription and no filter.

**Defense in depth (hooks):** `beforeMessageCreate` also checks that a DM's author is a member, in case
`@request.body.room.members` traversal behaves differently in the pinned PocketBase version (like the archived
guard, §5.6). Request-only hooks (`onRecordCreateRequest` / `onRecordUpdateRequest` on `rooms`) reject `kind`,
`members` and `last_message_at` in API writes, including field modifiers such as `members+`, which `:isset` rules
don't see. They don't fire for the route's and hooks' own `$app.save`.

**Query cost:** the `messages` list rule adds a join to `rooms` and, for DMs, a `json_each` over two members. The
history query still filters by `room` first, so `idx_messages_room_created` keeps serving it. The pagination
`EXPLAIN QUERY PLAN` test (§9.2) is repeated with the new rule in place.

### 16.4 Closing and reopening

**Close conversation** in a DM's menu creates a `hidden_rooms` row, exactly like hiding a room. Unlike hidden
public rooms, closed DMs are not listed under **Hidden rooms**; they simply leave the list.

A DM must not stay silent once the other person writes again. An after-create hook on `messages` in a DM deletes
the **recipient's** `hidden_rooms` row for that room, if there is one. That delete reaches the recipient's
`hidden_rooms` subscription (§6), so the DM reappears live. The same hook sets the room's `last_message_at`, which
reaches both members through their `rooms` subscription.

### 16.5 Frontend

- **Types:** `Room` gains `kind`, `members` and `last_message_at`, plus `expand.members` (`id`, `name`, `avatar`).
  `ROOM_FIELDS` and the rooms subscription request the same fields. Emails are never fetched.
- **`roomTitle(room, me)`** in `lib/rooms.ts`: the room name, or for a DM the other member's name. Used by the
  sidebar, the room header and `document.title`.
- **Sidebar** (`roomSections`, §7.4) gains a **Direct messages** section between Rooms and Hidden: open DMs sorted by
  `last_message_at` (then `created`) descending, each with the other member's avatar (§15.4). Closed DMs are omitted,
  and a DM without messages is listed only for the member who opened it, so opening one doesn't show up for the other
  person until something is sent (QA BUG-29). `%` in the search text is escaped: PocketBase's `~` treats it as a
  wildcard (QA BUG-34).
- **New message:** a **+** button in the DM section header opens a user search (`GET /api/chat/users?q=`,
  `pb_hooks/lib/users.js`: up to 20 other users by name, `id,name,avatar` only; debounced 200 ms, at least 1
  character). It matches the query's name key against `users.name_key` (§22.1), so case is ignored beyond ASCII
  ("иван" finds "Иван"), which SQLite's `LIKE` on `name` didn't do (QA BUG-55).
  Choosing a user calls `actions.openDm(userId)` → `POST /api/chat/dms` → `upsertRoom` → navigate to `/r/:id`.
- **From a message:** clicking an author's name or avatar opens a small menu with **Message** (hidden for yourself),
  which does the same.
- **Room view:** unchanged apart from the header, the composer placeholder ("Message Bob") and the beginning marker
  ("Beginning of your conversation with Bob"). A DM shows the other member's avatar and name, and its menu has
  **Close conversation** (then back to `/`) and **Jump to beginning**, never Archive. A closed DM opened by URL
  offers **Reopen conversation** instead.
- **Not a member:** opening `/r/:id` of someone else's DM gets a 404 from `getRoom`, which already shows "room not
  found".

### 16.6 Tests

- **Integration (rules):** C cannot list, view, subscribe to, or post in A–B's DM, and C's `"*"` subscription gets
  no events from it; nobody can create `kind: "dm"` through the `rooms` API, set `members`/`dm_key`, change `kind`,
  or archive or rename a DM; A and B can post, edit and delete their own messages in it.
- **Integration (route):** creates on first call and returns the same room afterwards, also when called by B for A;
  two concurrent calls create one room; own id, unknown id and an anonymous caller are rejected; it unhides the
  caller's closed DM; the rate limit returns 429.
- **Integration (hooks):** a message in a DM sets `last_message_at` and deletes the recipient's `hidden_rooms` row
  (and only theirs); a public-room message touches neither; `EXPLAIN QUERY PLAN` still uses the index.
- **Unit:** `roomTitle`; `roomSections` with DMs (ordering, closed DMs omitted, a DM is never in Archived); the user
  search debounce and empty results; **Message** from an author menu; the DM header and menu.
- **E2E:** A opens a DM with B from the user search and sends a message; B sees the DM appear in the sidebar live
  and replies; C's sidebar never shows it, and C opening its URL sees "room not found". B closes the DM, A writes
  again, and it reappears for B.

### 16.7 Users who take no direct messages

`users.no_dms` (bool, off by default) marks someone who doesn't take part in DMs: the Telegram bridge's stand-in
users (§26) have it, and a user may set it on their own record (the profile doesn't offer it yet).

- `POST /api/chat/dms` refuses when either person has it ("Ann doesn't take direct messages." / "You've turned off
  direct messages.").
- The messages create hook refuses a message in a DM where a member has it, so turning it on also closes DMs that
  already exist (they stay readable).
- `GET /api/chat/users` returns `no_dms`, and messages expand `author.no_dms`: the "New message" search and the
  forward dialog leave such users out, and their author name has no **Message** menu. Adding them to a private room
  (§23) still finds them.

## 17. Attachments

### 17.1 Data model

`messages` gains one field:

| Field | Type | Notes |
|---|---|---|
| `files` | file, multiple | `maxSelect` 10, `maxSize` 20 MB each (4 and 8 MB until 1760000018, raised to take a whole Telegram album, §26), **`protected: true`**, `thumbs`: `480x360` (center crop) and `240x180`. No `mimeTypes` allowlist: any file can be attached, because nothing is ever rendered from the file itself (§15 shared rules). |
| `file_names` | json | stored name → original upload name, written only by the create hook from the uploads themselves (bidi and invisible characters removed, 200 characters max); cleared by a soft delete, never changed by an edit (QA BUG-28) |

PocketBase's default request body limit (32 MB) doesn't fit 10 × 20 MB, and the records API is PocketBase's own, so
one route can't get its own limit: `main.pb.js` replaces the default with 201 MB (`$apis.bodyLimit`, same middleware
id), and a middleware (`lib/http.js` `bodyLimit`) answers 413 to any other request declaring more than 32 MB. A test
pins both.

**Text becomes optional when files are attached:** the hook rule "text is non-empty" (§5.6) changes to "text is
non-empty **or** at least one file is attached". A message with neither is still rejected.

**Files are immutable after sending.** Edits change text only: the update rule adds `@request.body.files:isset =
false`, and the update hook rejects any change to `files` (including the `files+` / `files-` modifiers) except the
soft-delete wipe below.

**Soft delete wipes the files.** When `deleted` becomes true, the hook also sets `files = []`. PocketBase deletes
the stored files after the update commits, so the content is really gone (§5.3), and the old URLs return 404.
PocketBase serves files with `Cache-Control: max-age=2592000`, so a browser that already loaded an attachment may
keep it in its own cache after the delete; the server copy is gone.

**Non-image files are downloads.** PocketBase serves types it doesn't consider safe to display (HTML among them)
with `Content-Disposition: attachment`, on top of the sandbox CSP, so opening one never renders it on our origin.

### 17.2 Rate limits and storage

- `messages:create` keeps its 10 per 5 s limit. Uploads are bounded by that, `maxSelect` and `maxSize`.
- Files live in `pb_data/storage` (or the S3-compatible storage configured in PocketBase's settings) and are part of
  backups, so backup sizes grow; §11 notes this.
- No per-user quota in this round (§13, still open).

### 17.3 Access control and file tokens

Because the field is `protected`, `GET /api/files/messages/:id/:file` requires `?token=` with a **file token**
(`pb.files.getToken()`), and PocketBase checks the **message's view rule** for the token's user. Therefore:

- DM attachments are visible only to the two members (§16.3), and public-room attachments only to logged-in users.
- A leaked URL stops working when its token expires (PocketBase's default file token lifetime is 3 minutes;
  Settings → Tokens).

**Token handling (`api.ts`, `lib/token.ts`):** `fileUrl(message, filename, thumb?)` builds URLs from a cached token.
The cache fetches a new token when the current one is older than 2 minutes, shares one in-flight request between
callers, and is dropped when the session changes. The room view waits for a token before its first render and
keeps one fresh (a check every 30 s). Links to full files re-sign their `href` on hover, focus and click, so a
click never uses a stale token. Already-rendered images keep their URLs (the browser has them). An image that is lazy-loaded later with an
expired token fails; its `error` handler asks for a fresh URL **once** and retries, then falls back to a "Couldn't
load image" box with a Retry button.

Tokens change the URL, so the browser cache can't reuse a thumbnail across token refreshes. The service worker
(§27.2) keeps thumbnails under their URL without the token instead, so switching rooms or reloading doesn't download
them again. Full files (the viewer, downloads, video and audio) still go to the server with their token.

### 17.4 Sending (optimistic, retry-safe)

The composer gains an **Attach** button ("+", opening a hidden `multiple` file input), drag-and-drop onto the room and paste
(`clipboardData.files`). Selected files show as a tray above the textarea: image thumbnails from object URLs,
other files as chips with name and size, each with a remove (×) button.

- Client checks before sending: at most 10 files, each ≤ 20 MB after preparation (§15.3, images re-encoded to at most
  2048 px). A rejected file shows why, inline, and is not added.
- Send works as in §7.5, with `FormData` instead of JSON: the client id, room, author, text and the files. The
  pending message shows the local previews dimmed, with a progress bar under them: a send with files goes through
  XHR (`pb.ts` `upload`, used when the request has an `onUpload` callback), since fetch can't report upload
  progress. The controller passes it on (`onUpload`), and the list moves the bar in place (`setUpload`), without
  re-rendering the message. The tray shows about three rows of files, then scrolls.
- **The pending entry keeps its `File` objects,** so **Retry** re-sends the same id with the same files. A duplicate
  id is still rejected by the server, so a retry after a lost response can never post twice.
- Once the server version replaces the pending one (§7.5 step 4), the object URLs are revoked.
- Leaving the room while an upload runs lets it finish (writes are not aborted, §6); a reload loses unsent files,
  like unsent text today.
- Archived rooms have no composer, so no attach button.

### 17.5 Rendering

- **Images** (by file extension: `jpg jpeg png gif webp avif`): a wrapping row under the text, uncropped, in their
  own aspect ratio. One image shows 240px high and at most 400px wide (the `800x480f` thumb); two or more show
  120px high and at most 240px wide (the `480x240f` thumb). At most 4 tiles show: with more images and videos the 4th
  says "+N" over it (N more), and the viewer (§17.7) steps through all of them. The height is fixed, so loading never shifts the list
  vertically: a too-wide image is narrowed and letterboxed rather than shortened, a very narrow one is centred in a
  tile at least half as wide as it is high, and a small one is never enlarged (`object-fit: scale-down`). A GIF's
  tile shows the file itself, not a thumbnail: PocketBase thumbnails a GIF from its first frame only, so it would
  not play (the full GIF is up to the attachment limit, and loads lazily like the thumbnails). While a
  message sends it shows the local previews, at the size its thumbnails will take: the thumbnails get the previews'
  aspect ratio before they load. Only files the server will show as images (by extension) show as previews. Clicking
  opens the image viewer (§17.7); a click asking for a new tab or window (Ctrl/Cmd/Shift/middle click) opens the full
  file there instead (`target="_blank" rel="noopener"`), served under the sandbox CSP.
- **Videos** (by extension: `mp4 m4v webm mov ogv`): tiles like images, in the same row and at the same sizes,
  showing the video's first frame with a play badge over it. There are no server thumbnails for videos: the tile is a
  `<video preload="metadata">` of the full file with `#t=0.001` (so every browser, Safari too, draws the first
  frame), and the browser fetches only enough of it to draw that. While sending, the local preview is the file's
  object URL (so the app CSP allows `media-src blob:`), and its aspect ratio carries over like an image's. Clicking
  plays it in the viewer (§17.7); a failed load retries once with a new token, then shows "Couldn't load video" with
  Retry (a format the browser can't play ends up there too; Ctrl/Cmd-click still gets the file).
- **Audio** (by extension: `mp3 m4a aac ogg oga opus wav flac weba`): the download chip with an
  `<audio controls preload="metadata">` of the full file next to it (as high as the chip, at most as wide as the
  message), named after the file, so it plays in the message. Its token expires (§17.3), so playing or seeking long
  after it loaded can fail: the first error after a load gets a new token, reloads the file and carries on from the
  same time (playing again if it was). Players are kept by message and file across renders (a new reaction or an edit
  re-renders the message without stopping one), and stopped once off the page (a deleted message, a message gone from
  the window, unmount): a detached `<audio>` would keep playing. While sending, audio is a plain chip.
- **Other files:** a chip with an icon, the display name and a download link (`download` attribute).
- **Display name:** PocketBase stores `quarterly_report_final_k3j2h1g0f9.pdf` for "Quarterly Report (final).pdf". The
  create hook records each upload's original name in `file_names` (§17.1), and the list shows and downloads files
  under it (`attachmentName()` in `lib/files.ts`). Messages from before that field fall back to `displayName()`,
  which strips the `_` + 10-character suffix (QA BUG-28).
- **Deleted messages** show the placeholder only (the files are gone, §17.1).
- **Edit mode** edits only the text; attachments stay visible below the textarea, without remove buttons. The text
  of a message with attachments may be emptied.
- `MSG_FIELDS` gains `files`, and the `messageNode` signature includes it.

### 17.6 Tests

- **Integration:** files-only message accepted, no text and no files rejected; a 5th file and an over-size file are
  rejected; the file URL without a token is 403/404, with A's token works, and with C's token on an A–B DM file
  is 404; responses carry the sandbox CSP and `nosniff` (an uploaded `.html` and `.svg` included); an edit cannot
  add, remove or replace files; soft delete empties `files` and the old file URL returns 404; the body limit fits
  10 × 20 MB, and other requests still get 413 over 32 MB.
- **Unit:** `displayName`; token cache (reuse, refresh after 2 min, one in-flight request); the composer tray (add,
  remove, limits, paste, drop); optimistic send with files, failure, and Retry with the same id and files; object
  URLs revoked on ack, removal and unmount; image grid layout classes for 1–4 images, and "+N" past 4; the upload
  progress bar; expired-token retry happens once.
- **E2E:** A attaches an image and a PDF and sends; B sees the thumbnail and the file chip live and can open both;
  in a DM, C can't load the file URL even when given it; deleting the message removes the attachments for B; the
  XSS smoke test (§9.3) also uploads an `.html` file and checks that opening it runs no script.

### 17.7 Image viewer

Clicking a thumbnail shows the image full size in a full-window viewer, and you can step through every image and
video in the room, oldest first: those of the room's window (§7.5) to start with, and the others fetched from the
server as you get near them.

- **What it shows:** the full file (not a thumbnail; uploads are at most 2048 px, §15.3), fitted to the window; a bar
  with the file name, who sent it and when, "*n* / *total*", **Download** (`download` attribute, re-signed before use
  like every file link, §17.3) and **Close**. Images of deleted messages and of messages still sending are left out.
  It starts with the window's images; it doesn't follow new messages.
- **Beyond the window:** when the image shown is within 3 of the first or last one it has, and the room has messages
  beyond the window on that side (`hasOlder`/`hasNewer`), it fetches the next page of the room's messages that have
  attachments (`withFiles` in `lib/cursor.ts`: `files:length > 0`, the usual `(created, id)` cursor from its first or
  last image), and the next while a page has none to show (only other files). Stepping past the end waits for it;
  a failed fetch is tried again by the next step. Previous/Next stay while there may be more. The count shows once the
  viewer has the whole room's images (at once in a room that fits the window), since it can't know the total before.
  The paging is in the viewer chunk; the room view passes only the page request and which files are images or videos.
- **Moving:** Previous/Next buttons on the sides (hidden at the first and last image), ←/→, Home/End, or a one-finger
  horizontal swipe (≥ 50 px, mostly horizontal; pinch-zoom still works). The neighbours are preloaded, so stepping is
  instant.
- **Closing:** Close, Escape, a click on the dark space around the image, or the browser's **Back** (Android's back
  gesture too). Focus goes back to the thumbnail, or to the one drawn in its place if its message was redrawn while
  the viewer was open (a reaction, an edit). Leaving the room closes it. Keys pressed before it shows (its stylesheet
  is still loading) are still the page's.
- **Back:** opening the viewer pushes a history entry with the same URL (`history.state.viewer`, a token new on each
  page load, so an entry left from before a reload isn't taken for one). Back leaves it: `popstate` closes the viewer,
  and since the path doesn't change, the router's `popstate` handler finds the page already shown and does nothing. Closing it any other way
  goes back over the entry (`history.back()`), so Back then works as before; a viewer opened again before that Back has
  landed waits for it, or the Back would close it. Leaving the room doesn't go back (it would undo the navigation).
  An entry with no viewer open on it (Forward after Back closed the viewer, a reload while it was open, one left by
  leaving the room) would take a Back that seems to do nothing, so the router passes over it with `history.back()`
  whenever it lands on one, on start or on `popstate`.
- **Videos** step along with the images. One plays in a `<video controls>` (autoplay where the browser allows it, else
  the controls start it); stepping away or closing stops it and drops its download. Neighbouring videos aren't
  preloaded. Swipes don't start on the video (dragging its seek bar isn't a swipe) and the arrow keys are the video's
  own while it has focus. A video whose token expires mid-play (the browser fetches it in ranges) gets a new token and
  carries on from where it was.
- **Failures:** an image that doesn't load gets one retry with a new file token (an expired token is the usual cause),
  then "Couldn't load image" with Retry, like thumbnails (§17.3).
- **Accessibility:** a modal `<dialog>` (focus stays inside, the room behind is inert), named after the image shown;
  the caption is a polite live region, so stepping announces the new image; the image's alt text is its file name.
- **Look:** dark in both themes, so the image stands out.

**Loading (the main bundle stays as it was).** `views/room/viewer.ts` is a lazy chunk: the room view `import()`s it on
the first click (`app.js` grew by 0.2 KB gzipped for the click handler and the import), and it links its own
stylesheet, `viewer.css`, before it shows. Both have hashed names and a budget of their own (§7.7). It imports only
types (§7.7: a lazy module mustn't share modules with `app.js`); the DOM helper, names, dates and signed URLs come
from the room view as options. If the chunk can't be loaded (offline, or a new version was deployed and the old chunk
is gone), the image opens in a new tab as before.

An iframe with the viewer inside was considered and rejected: it is a heavier way to load code lazily (its own HTML
document, and its own copy of the session and file-token code), keyboard focus and Escape don't cross into an iframe
by themselves, and `frame-ancestors 'none'` (§5.6) would have to be relaxed.

**Not done yet:** zooming in beyond fit-to-window is the browser's pinch-zoom only.

**Tests (e2e):** the chunk and stylesheet aren't loaded before the first click; the viewer covers the window, shows the
full image, steps with the keys, the buttons and a swipe (which isn't taken for a click that closes it), the Download
link works, Escape and a click beside the image close it and focus goes back to the thumbnail; Back closes it and
stays in the room, and after Escape its history entry is gone; closing and opening again at once leaves it open;
Forward after Back and a reload while open leave no entry behind; focus finds the thumbnail after its message was
redrawn; keys pressed while its stylesheet is still loading don't step; Ctrl/Cmd-click still opens a tab. **Unit:** the build helpers (no shared chunk, the stylesheet define, budgets).

## 18. Unread counts

Every room and DM in the sidebar shows how many messages you haven't read yet, live. Decisions: §13 (2026-10-11).

### 18.1 Data model: `room_reads`

| Field | Type | Notes |
|---|---|---|
| `user` | relation → users | required, cascade delete |
| `room` | relation → rooms | required, cascade delete |
| `last_read_at` | date | required: you have read every message created up to and including this time |

Unique index on `(user, room)`. Rules: list and view `user = @request.auth.id` (so each user gets their own rows
live); create, update and delete `null`. Only the route below writes rows, so a client can't move its read position
back, set it in the future or write someone else's.

No row means "read up to your signup" (`users.created`): history from before you joined never counts.

### 18.2 Routes (`pb_hooks/lib/reads.js`)

- **`GET /api/chat/unread`** → `{ at, rooms: { "<roomId>": count }, ids }` for the rooms with anything unread, where `at`
  is the server time the counts were taken (answers older than the counts shown are dropped), and `ids` the other
  people's messages of the last 30 s in rooms you can see, read or not: the ones these counts account for (§18.3,
  QA BUG-106). One SQL statement, so the counts and `ids` come from one snapshot: for each room you can see (public, or a DM
  you are in), count the messages that are not yours, not deleted, and newer than `max(last_read_at, your signup)`,
  **stopping at 100** (the badge shows `99+`; without the cap a 50k backlog took ~200 ms per request). Each count is
  a correlated subquery, so it is a range scan on `idx_messages_room_created` (an integration test pins the query
  plan). Hidden and archived rooms are counted
  too; the client decides what to show (§18.4), and a room you unhide shows its real backlog.
- **`POST /api/chat/reads`** `{ room, at? }`: you have read `room` up to `at` (a message's `created`; default now).
  The position only moves forward and never past now; `at` must be a date (`""` is a 400, not "now"). A room you can't see (someone else's DM, no such room) is a
  404. Two tabs racing to create the row end up with one (the unique index, then an update). Rate limit: 120 per
  60 s per IP; the client sends at most about one per second per open room.
- **`GET /api/chat/unread/{room}`** → `{ id, created }` of the oldest message in `room` that is unread by the same
  rule (not yours, not deleted, newer than `max(last_read_at, your signup)`), or `{ id: "", created: "" }`. 404 for a
  room you can't see. §18.5 opens the room there.

### 18.3 Client

- **One service, `unread.ts`,** started and stopped with the session next to `sync.ts` (`app.ts`). It owns the counts
  and everything about telling the server what was read. Views only read the store and report what they show.
- **State:** `AppState.unread` (room id → count). Loaded at login and on every reconnect; `refresh()` refetches,
  debounced. A failed count never affects the room list.
- **Live +1:** the service subscribes to **all** message events (`fields: id,room,author,deleted`, never the
  text), which the messages list rule already limits to rooms you can see. A create from someone else in a room
  other than the active one is +1. A soft delete in a room with unread messages refetches the counts (was the
  deleted message unread?). A count request in flight may or may not include a +1 that arrives meanwhile: the +1s
  received during it are kept, and those whose message isn't in the answer's `ids` are added on top. (Refetching
  instead starved the counts in a busy room: QA.) A +1 whose message is in the `ids` of the counts shown is skipped:
  its event came after them (SSE can trail the HTTP answer). Times can't decide this: a message is committed some
  time after its `created`, so one created before `at` may be missing from the counts and one created after it
  included (QA BUG-106). An answer older than the counts in the store is dropped.
- **Other tabs and devices:** `room_reads` events (your own rows only) refetch the counts, debounced (250 ms).
- **Marking read:** the room view opens a `RoomReader` (`unread.open(roomId)`) on mount. After every render, scroll
  and visibility change, if the newest messages are on screen (the window reaches the live edge, §7.5, the list is
  scrolled to the bottom, and the tab is visible), it calls `reader.seen(newest confirmed message's created)`. The
  reader clears the room's count in the store at once and, at most once a second, sends the position to
  `POST /api/chat/reads`. A failed send is retried with the next `seen()` (a reconnect's gap fill renders). On
  unmount the view calls `reader.close(caughtUp)`: a pending read goes out immediately, and when not caught up the
  counts are refetched, because messages that arrived meanwhile weren't counted (it was the active room).
- **Whose read:** the session is shared by every tab, and another tab can switch it to another user. A reader
  remembers who it was opened for and never sends a read as anyone else. Ending the session (`endSession()` in
  `app.ts`) calls `unread.flush()` first, so logging out still sends the pending read while the session exists;
  after a switch from another tab, the same flush sends nothing.

### 18.4 Rendering

- A pill after the room name (`.badge`, the accent gradient, `99+` past 99) and a bold name. The badge holds a
  visually hidden " unread", so a screen reader reads "general, 3 unread".
- **No badge** for the active room, hidden rooms or archived rooms (`unreadCount()` in `store.ts`). The tab's
  count (§22.4) does include the active room while the tab is away.
- Room rows are now flex rows: the name ellipsizes, and the `#`, the avatar and the badge always stay visible.

### 18.5 Opening at the first unread message

- Opening a room that has unread messages in the store (the room list showed a badge; not with `/m/:msgId`, which
  wins) asks `GET /api/chat/unread/{room}` where the first unread message is, beside the latest page. The first window
  is then the latest page if it holds that message, else the page before it plus it and the page after (`windowAt` in
  the controller), scrolled so that it sits a quarter of the way down the list. Without unread messages nothing extra
  is fetched.
  Before the counts are in (the store's `unread` is still `UNCOUNTED`: a reload, a restored tab, a link to the room)
  the server is asked too: the room would otherwise open at the bottom and take every unread message as read
  (QA BUG-93).
- **The "New" line:** a red line with "New" (`li.new-line`) over that message, for `UNREAD_LINE_MS` (5 s); it fades
  out in its last second. It has no height, so nothing moves when it goes.
- **Room cache (§7.5):** the server isn't waited for. With the counts in, the first unread message is worked out from
  the kept window by the server's rule (the room's count of other people's messages that aren't deleted, counted
  back from the newest); the kept window is shown at once scrolled to it if it holds them all and was prefetched with
  that very count (`Kept.unread`; a message that came since, or a prefetch not run yet, would put the line on one
  already read: QA BUG-99), and otherwise the room waits for the server's window. Before the counts are in (a reload) it
  is shown at the bottom, and when the server says where they start it goes there (unless you scrolled away), or, if
  they weren't kept, the first page does. When the page comes, the list otherwise stays where it is, even if you
  scrolled to the bottom meanwhile (QA BUG-96).
- **One round trip:** the latest page is asked for beside the first unread message, not after it. When it holds that
  message (a few unread), it is the first window; only with more does the room fetch the pages around it.
- Reading is unchanged (§18.3): the room is marked read only once its newest messages are on screen.

### 18.6 Tests

- **Integration:** counts (others' messages only; deleted, own and pre-signup ones excluded; DMs only for
  members); the first unread message (same rule, after a read, 404 for invisible rooms, 401 anonymous); reads (clears up to `at`, default now, never back, never past now, one row under concurrent calls; 404
  for invisible rooms, 400 for bad and empty dates, 401 anonymous); `at`; the cap at 100; `room_reads` rules (private,
  no API writes, live only to its owner); the rate limit; the query plan.
- **Unit:** store updates and `unreadCount`; `unread.ts` (initial load, live +1 except own and active room, delete
  refetch, reads from another tab, failed counts, a +1 during a request, a room that never stops, debounced refresh;
  the reader: batching, close, flush, never as another user, retry, nothing after stop); room view (marks on open and
  live, opens at the first unread message with the "New" line, which goes after `UNREAD_LINE_MS`, flushes on leave, not from history, scrolled up or in a hidden tab, retries a failed read); app (logout sends a
  pending read); sidebar badges (count, `99+`, label, none where silent,
  live).
- **E2E:** Ada writes, Bob's badge counts live and survives a reload; opening the room clears it in Bob's other tab;
  new messages count again. Scrolled up, a new message stays unread until Bob scrolls down to it.

## 19. Replies

Any message in a room or DM can be answered with a reply that quotes it. Clicking the quote shows the original,
wherever it is in the history.

### 19.1 Data model

`messages.reply_to`: an optional relation to another message (max 1, no cascade). Messages are only ever
soft-deleted, so the relation never dangles: a reply to a deleted message quotes "Message deleted".

- **Set on create only.** The update rule adds `@request.body.reply_to:isset = false`, and `beforeMessageUpdate`
  refuses any change to it (backing up the rule against field modifiers).
- **Same room, not deleted** (`assertReplyTarget` in `pb_hooks/lib/messages.js`). Without the room check, a reply could
  point into a DM you aren't in, and its expanded quote would show you that message.
- **Hard deletes still work.** When a superuser deletes a message (or a room) for good, PocketBase clears
  `reply_to` on its replies once the original is gone. `beforeMessageUpdate` lets that one save through
  (`replyTargetRemoved`); otherwise its guards would refuse it, and the delete with it.

### 19.2 API

Every message read (`page`, `getMessage`, `changes`, `send`, realtime) expands `author,reply_to.author` and asks for
only what the quote shows: `reply_to`, and the original's `id, author, text, deleted, files` and author's
`id, name` (`MSG_FIELDS` in `api.ts`). The expand follows the messages view rule, which the same-room check makes
always true for someone who can see the reply. `NewMessage.replyTo` sends `reply_to`.

### 19.3 Frontend

- **Reply** joins Edit and Delete in a message's action pill, on any message that is saved, not deleted, in a room
  that isn't archived (`ctl.repliable`). It shows "Replying to *name* *text*" above the composer (×, or Escape in the
  textarea, cancels) and focuses the textarea. The next send is the reply; the optimistic message quotes the
  original at once (`quoteOf` in `lib/messages.ts`).
- **Ctrl+Up / Ctrl+Down** in the textarea move the reply to the previous / next repliable message in the window and
  scroll it into view; Ctrl+Up while not replying starts a reply to the newest one, and Ctrl+Down past the newest ends
  the reply.
- The reply bar follows the original: edited, it shows the new text; deleted (or the room archived), it closes.
- **The quote** is a one-line button above the reply's text: author name, then the text on one line (or
  "Attachment", "Message deleted"). It uses the window's copy of the original when there is one, so edits and
  deletes show live; otherwise the server's expanded copy.
- **Going to the original** (`ctl.goTo`): if it is in the window, it is highlighted (`.target`) and centred. The
  highlight (here and for `/r/:id/m/:msgId`) holds briefly, fades out, and is dropped after `HIGHLIGHT_MS` (3 s). If not,
  the window is replaced by the history around it (as for `/r/:id/m/:msgId`, §7.5) once that has loaded; the old
  window stays until then. The URL doesn't change, so the composer and anything typed into it stay. Unsent
  (pending or failed) messages the new window drops are kept aside and come back at the live edge. A send
  that completes meanwhile is not added to the history window.
- **The original deleted unseen:** the send fails with a `reply_to` error. The message then says "Not sent: the
  message you replied to was deleted", its quote shows as deleted, and **Send without quote** sends it as a plain
  message.
- The quote's accessible name is "Quoting *name*: *text*", capped at 80 characters, so that it doesn't read a whole
  long message aloud and doesn't start with "Reply" like the Reply button. Escape doesn't cancel a reply while an
  input method is composing.

### 19.4 Tests

- **Integration** (`replies.test.ts`): same-room replies; refused across rooms, into a DM you aren't in, to unknown
  or deleted messages; `reply_to` never changes; a deleted original stays quoted as deleted; the quote comes back
  through send, page, getMessage and realtime with only its fields; field modifiers can't touch `reply_to`; a
  superuser can delete an original or a room holding replies.
- **Unit** (room view): reply bar and send; cancel with × and Escape; stepping with Ctrl+Up/Down; quotes that go to an original on screen and
  one far back in history; a quote and the reply bar following an edit and a delete; no Reply when archived, deleted
  or still sending; archiving ends the reply, and unarchiving doesn't bring it back; Escape while composing; a send
  or a failed message during a quote's history load; a reply to an original deleted unseen; the quote's name.
- **E2E** (`replies.spec.ts`, light and dark): Bob replies to Ada and she sees the quote live; Ada replies to a message
  far back in history, and Bob's click on the quote loads that history and highlights it; axe finds no serious
  violations in the reply bar or the quotes.

## 20. Reactions and emoji

Anyone who can read a message can react to it with emoji, as many different ones as they like, and the composer has
an emoji button. Decisions: §13 (2026-10-11, reactions and emoji).

### 20.1 Data model

`messages.reactions`: a JSON list with one entry per emoji, in the order each was first used. Each entry holds the ids
of who reacted with it, in the order they did: `[{ "emoji": "👍", "users": ["<id>", …] }, …]`. An emoji nobody uses
any more is removed; `[]` when there are none.

- **Only the route below writes it.** The create and update rules add `@request.body.reactions:isset = false`. The
  create hook sets `[]` whatever was sent, and a request hook (`beforeMessageUpdateRequest`) refuses an update that
  changes it, superusers included. The route's own saves don't go through request hooks.
- **The emoji are the picker's** (`pb_hooks/lib/emoji.js`, the same list as `web/src/lib/emoji.ts`; a unit test fails
  if they drift apart). Anything else is a 400.
- **A soft delete wipes them** with the text and files (§5.6). Edits keep them, and they never set `edited_at`.
- **An edit keeps the stored reactions**, not the ones loaded with the record. PocketBase writes every field on a save,
  so an edit that read the message before a reaction was added would otherwise erase that reaction.
  `beforeMessageUpdate` re-reads them, and the update request runs in a transaction so that nothing can commit between
  that read and the write.

### 20.2 `POST /api/chat/reactions`

`{ message, emoji, on }` → the message, expanded and filtered like a read of it (`?expand`, `?fields`): the caller's `emoji` reaction on `message` is there
(`on: true`) or not (`on: false`). Setting a state rather than toggling makes it idempotent, so a retry or a double
click can't flip it back. The whole message comes back, not just its reactions. A client that patched only the reactions
and took the newer `updated` would hide an edit it hadn't heard of yet (its realtime connection was down), even from
the reconnect refetch.

1. `emoji` not in the set, or `on` not a boolean: 400.
2. A message the caller can't see (the messages view rule, via `canAccessRecord`) is a 404, like one that doesn't exist.
3. In one transaction: read the message, refuse it if it is deleted or in an archived room (400), change the list,
   save. Because the read and the write share one transaction, two people reacting at the same moment both count.
4. Nothing to change (already there, or not there to remove): no save, the same answer.

Saving the message bumps `updated`. The change therefore reaches every client as a messages `update` event, wins over
older copies in `merge` (§7.5), and is picked up by the reconnect refetch of changed messages. `MSG_FIELDS` gains
`reactions`. Rate limit: 30 per 10 s per IP. The unread counter ignores these updates (only deletes matter to it, §18.3).

### 20.3 Frontend

- **Showing them:** under a message's text and attachments, a chip per emoji with its count; yours are tinted and
  `aria-pressed`. The tooltip says who: "You, Ada and 2 others reacted with 🎉". Names come from the window's
  authors. Anyone else is looked up (`api.usersById`), with one request for all the unknown names a render needs.
- **Changing them:** clicking a chip adds yours or takes it back. **☺+** ("Add reaction") in a message's action pill, and the same
  after the chips, open the picker; picking an emoji you already used takes it back. In archived rooms the chips show
  but are not buttons, and there is no ☺+.
- **Optimistic:** a change shows at once, as an overlay over every copy of the message (the controller's `reactions(m)`)
  until the server answers. A realtime update made before yours therefore doesn't flicker it away. The requests for one
  message go one at a time, in order, and a change superseded before its request went out is skipped. The server ends
  up with the last choice, in the order the changes were made. A failure shows the reaction as it was, with an inline
  error and Retry. A request that fails after a later change to the same reaction isn't reported, since the later one
  decides what shows.
- **Focus** stays on the chip that changed, or moves to the action pill's ☺+ when the chip is gone (a failure, the last one taken
  back). A message is redrawn whenever it changes, for instance when someone else reacts. When that replaces the
  focused button, focus moves to the new one.

### 20.4 Emoji picker (`ui/emoji-picker.ts`)

One popover per room view, used by the composer's emoji button (it inserts at the caret, replacing a selection) and by
reactions. It is a `role="dialog"` named for what it does ("Insert emoji", "Add reaction"). It sits next to its button
(above it when there is room) and spans the screen width on phones.

- Category tabs, then a **Recent** row (the last 24 picked, kept in `localStorage`; nothing breaks without storage),
  then the categories, in an 8-column grid. Built on first open.
- **Keyboard:** the grid is one tab stop (roving `tabindex`). Arrow keys move within and across categories, Home and
  End go to the ends, and Enter or Space picks. **Escape** closes it and gives focus back (to the composer, or to the
  message's ☺+). Clicking or tabbing elsewhere closes it. A window resize moves it along rather than closing it. On
  Android the page resizes when the keyboard goes away (`interactive-widget=resizes-content`), and opening the picker
  takes the focus from the composer, which hides the keyboard.
- The emoji are toggle buttons (`aria-pressed`) only for reactions, where picking can take one back. For the composer
  they are plain buttons.
- Each emoji button is named by the emoji itself, which screen readers read out by name.

### 20.5 Tests

- **Integration** (`reactions.test.ts`): adding and removing several emoji per user; idempotent; text and `edited_at`
  untouched, `updated` bumped; concurrent reactions all count, also against concurrent edits; the answer is the whole
  message, expanded; only the set's emoji and a boolean `on`; 404 for
  invisible messages, 401 logged out; refused on deleted messages and in archived rooms; wiped by a soft delete, kept by
  an edit; clients (and superusers) can't write the field; returned in `MSG_FIELDS` and live; the rate limit.
- **Unit:** the client and server emoji sets match, with no duplicates and one grapheme each; recent emoji (order, cap,
  storage failures); `setReaction` and `reactors`; picker arrow-key steps, opening, picking, Escape and outside clicks;
  the controller's overlay over a stale copy, a superseded failure not reported, the answer bringing an edit that
  realtime missed, and where you can't react. The picker stays open on a resize and isn't a toggle when inserting. Room view: React and pick; chips toggling;
  live reactions from others, with their names looked up; taking one back from the picker; failure and Retry; a
  reaction changed again before the answer; focus, also across redraws and failures; archived and deleted messages; the composer inserting at the caret.
- **E2E** (`reactions.spec.ts`, light and dark): Ada inserts an emoji from the composer's picker. Bob reacts twice, once
  by keyboard. Ada sees both live, with Bob's name, and adds hers. Reactions survive a reload, and axe finds no serious
  violations in the open picker or the chips.

## 21. Selecting, forwarding and deleting several messages

Messages can be selected, one or many, then forwarded to another room or DM, or deleted together when they are all
yours. A single message can be forwarded straight from its action pill. Decisions: §13 (2026-10-11, selecting,
forwarding and deleting several messages).

### 21.1 Selecting

- **Select** in a message's action pill starts selecting, with that message selected. While selecting, every
  selectable message (saved, not deleted: `ctl.selectable`) has a checkbox ("Select message from Ada, …"); a click
  anywhere on a message toggles it too, rather than following a link or pressing a button in it. Selected messages are
  tinted. Single-message actions (the pill, the delete confirm, an open edit box) are gone meanwhile.
- **The selection bar** replaces the composer (which keeps what was typed): "*n* selected", **Forward**, **Delete**
  (only when you could delete every selected message, §7.6.1) and **Cancel**. Delete asks first in the bar ("Delete
  these 3 messages?", focus on Cancel).
- **Stopping:** Cancel, Escape, or unselecting the last message; focus goes back to the composer. A selected message
  that leaves the window, or is deleted meanwhile, is unselected.
- **At most 50** (`MAX_SELECTED` in `lib/limits.ts`, `MAX_MESSAGES` in `pb_hooks/lib/bulk.js`). One more is refused
  with a notice above the list (gone when selecting stops), and its checkbox stays unchecked.

### 21.2 Deleting: `POST /api/chat/delete`

`{ messages: [ids] }` → the messages, soft-deleted, expanded and filtered like a read (`?expand`, `?fields`).

1. 1 to 50 distinct ids, else 400. Any message the caller can't see (messages view rule) is a 404 for the whole request.
2. Any message that isn't the caller's is a 403; any in an archived room a 400.
3. In one transaction, each message not yet deleted is saved with `deleted: true`. The save goes through
   `beforeMessageUpdate` (§5.6), which wipes text, files and reactions as for a single delete; already deleted ones
   are left alone, so a retry succeeds.

Every room member gets the usual realtime `update` per message. The client shows the placeholders at once
(`ctl.removeMany`) and puts the messages back, with a notice, if the request fails. Rate limit: 20 per 60 s per IP.

### 21.3 Forwarding: `POST /api/chat/forward`

`{ messages: [ids], room }` → the new messages, oldest first, expanded and filtered like a read.

1. 1 to 50 distinct ids (400). A target room the caller can't see is a 404, an archived one a 400. Any message the
   caller can't see is a 404, and any deleted one a 400: forwarding never reveals a message you couldn't read.
2. In one transaction, a new message per original, in the originals' order (`created`, then id): `author` is the caller,
   `forward_of` the original (for a forward, the message it shows: chains are one step), `forwarded_from` the
   original's `forwarded_from` or else its author, and `text` empty. Nothing is copied, so a forward is one row however
   big the attachments are. The forwards are `created` a millisecond apart so they keep their order. The saves go
   through `beforeMessageCreate` and `afterMessageCreate` like any message: a DM's members are checked, a closed DM
   reopens for the recipient, and unread counts and realtime follow. A message whose original is deleted or gone is a
   400, like a deleted one.

**Forwards show their original** (`messages.forward_of`, a relation to `messages`, max 1, no cascade):
- *What is shown.* `onRecordEnrich` (`showOriginal`) fills in a forward that isn't deleted with its original's
  `text`, `files`, `file_names` and `edited_at` in every answer and realtime event, expanded replies included (a
  reply to a forward quotes the original's words). Once the original is deleted they are empty, and the client shows
  "The original message was deleted" under "Forwarded from *name*"; a superuser removing it for good clears
  `forward_of` (let through by `beforeMessageUpdate`, as for `reply_to`), with the same result. Nothing is saved.
- *Who may see the original.* The messages **view** rule adds: a forward of this message that isn't deleted is in a
  room the caller can see (an aliased `@collection.messages:fwd` join with "any of" operators, so every condition is
  about the same forward). That covers reading it by id, expanding it and its attachments' URLs (the client signs
  `/api/files/messages/<forward_of>/…`). The **list** rule is unchanged: the original's room, its other messages and
  replies stay hidden, and the routes that act on a message (reactions, forward, delete) check the list rule, so a
  forward's reader can't react to the original or forward it by id. Deleting the forward ends the grant. Read that way,
  the original keeps to itself what would say who is in its room: `keepToRoom` (`onRecordEnrich`) empties its
  `reactions` and `reply_to` for anyone who can't see its room (QA BUG-80).
- *Live.* A reader of the forward can't subscribe to the original's room, so after an edit or delete of a message
  (`changesForwards`), `touchForwards` saves its forwards again (nothing changes but `updated`), which sends them out
  with the original as it is now. Forwards in archived rooms can't be saved: they show it when loaded.
- *The viewer* pages through `files:length > 0 || forward_of != ""`: a filter can't see the original's files (relation
  filters apply the original room's rules), so forwards without media are skipped in the client.
- `forward_of` is set only by the route: the create and update rules add `@request.body.forward_of:isset = false`,
  and `beforeMessageCreateRequest` / `beforeMessageUpdate` back that up against field modifiers, superusers included.
  `beforeMessageCreate` checks the original is there, not deleted and not a forward. `MSG_FIELDS` gains `forward_of`.

**`messages.forwarded_from`**: an optional relation to `users` (max 1, no cascade). The create and update rules add
`@request.body.forwarded_from:isset = false`; `beforeMessageCreateRequest` and `beforeMessageUpdate` back that up
against field modifiers (superusers included). As with `reply_to` (§19.1), `beforeMessageUpdate` lets PocketBase
clear it when a superuser deletes the user it names. `MSG_FIELDS` gains `forwarded_from` and its expanded `id` and
`name`; the message shows "Forwarded from *name*" above its text. Rate limit: 20 per 60 s per IP.

**A forward can't be edited**, only deleted: its words are someone else's (they change only when their author edits the
original), and "Forwarded from Bob" must stay true.
`beforeMessageUpdate` refuses a text change on a message with `forwarded_from` (400); the client splits
`ctl.editable` (no Edit button, skipped by Up arrow) from `ctl.deletable` (Delete, the selection bar).

**The forward dialog** (`views/room/forward.ts`) is a modal `<dialog>` named "Forward *n* messages": a search box
that filters your open DMs (most recent first), rooms and hidden rooms by title (a room shows its name after a "#" icon), and also finds people you have no DM
with yet (`api.searchUsers`, debounced); picking one of those opens the DM (`actions.openDm`) first. On success the
dialog closes, selecting stops and the view goes to the target room (or, for the room you are in, says "*n* messages
forwarded"). Messages deleted since the dialog opened, and forwards whose original was, are left out (QA BUG-79); with
none left nothing is sent. A failure, with the server's reason, is shown in the dialog, which stays open to try again.
A forward whose original was deleted has no Forward in its pill. While a forward is on its way the dialog
can't be cancelled (Cancel disabled, Escape refused), and if the browser closes it anyway a failure reopens it: what
happened must be seen. While a people search is pending the status says "Searching…", not "Nothing found."; people
found for an earlier query stay only while they match the new one.

The pill's Forward button has the class `forward` too, so the dialog's styles are scoped to `dialog.forward`.

### 21.4 Tests

- **Integration** (`bulk.test.ts`): a forward can be deleted but not edited; delete several, all or nothing (someone else's message → 403), idempotent, refused
  in archived rooms and for invisible or unknown messages, live for others; forward in order with `forwarded_from`
  and `forward_of` (pointing at the original through a forward of a forward), nothing stored but the pointer, edits and
  deletes of the original showing live, an original removed for good, no files copied and the original's readable
  wherever the forward is (guests in Open Air rooms too, nobody else), the grant limited to that one message and ended by
  deleting the forward, a reply quoting the original's words, the answer expanded like a read, into a DM only for its
  members and reopening it, nothing forwarded from a DM you're not in or of deleted messages, clients (and superusers)
  can't set or change `forwarded_from` or `forward_of`; the rate limits. **E2E** (`attachments.spec.ts`): a forwarded
  image's thumbnail and viewer load from the original.
- **Unit** (room view): selecting by Select, checkbox and click; Cancel, Escape and the last unselect; deleted and unsent
  messages not selectable, one deleted meanwhile unselected; the 50 limit; Delete only for your own, its confirm, one
  request, and a failure putting them back; forwarding a selection in order and going there; forwarding one message to
  someone found by name; a failed forward and forwarding into the same room; archived rooms; forwards have Delete but
  no Edit and Up arrow skips them; the limit notice goes when selecting stops; a forward can't be cancelled halfway and
  a failure is always seen; "Searching…" until the people search answers.
- **E2E** (`forward.spec.ts`, light and dark): Ada selects Bob's message and hers, forwards both to Bob (found by name),
  and Bob sees them live with "Forwarded from"; she then deletes two of her own at once and Bob sees the placeholders.
  axe finds no serious violations while selecting or in the dialog.

## 22. Accounts and quality of life

### 22.1 Unique display names

`users.name_key` (hidden text, unique index where not empty) holds the name's key: `nameKey()` in
`pb_hooks/lib/text.js`, the same NFKC + case folding without invisible characters as room names (§5.2). `beforeUserSave`
sets it after cleaning the name and refuses a key someone else has: 400, `name: validation_not_unique`, "This display
name is taken. Choose another one." (shown next to the field by sign up and the profile). An update that keeps the name
keeps its key without checking it. The migration (`1760000012_accounts.js`) backfills the keys; names that already
clashed get a key made unique with the user id (`key#id`), so those accounts keep their name and can still change
their picture or password, but nobody new can take it. Tests free a fixed name such as "Ada" the same way before
signing it up again (`tests/support/names.ts`), since every test shares one server.

### 22.2 Password and Log out on the profile page

`POST /api/chat/password` (`pb_hooks/lib/account.js`, logged in only) takes `oldPassword` and `password`. It checks
the current password (400 on `oldPassword` if wrong), refuses an unchanged one, sets the new one (the field's own
rules, e.g. at least 8 characters, apply), refreshes the user's token key, so every token issued so far stops working
(other devices are signed out), and answers like a login (`{ token, record }`). `api.changePassword` saves that
answer, so this tab (and the others of this browser, which share the session) stays logged in. Rate limit: 5 per 60 s.
It is the only way to change a password: the users update rule refuses `password` (QA BUG-53).

Who a realtime client is comes from the token its subscriptions were sent with, so whenever the token changes the
client sends them again (`pb.ts`, QA BUG-52). A device that was signed out finds out when the server refuses a change
it sends (`api.onRejected`, checked at most every 30 s) or when its tab comes back after 5 minutes: the session check
(`refreshAuth`) then fails and it goes to the login screen (QA BUG-51).

The profile page has a "Password" form (current, new, confirm; checked in the page first, each error under its field)
and a "Session" section with **Log out**, which moved there from the app bar.

### 22.3 Drafts survive a reload

`web/src/drafts.ts` keeps what is typed in the composer under `chat.draft.<user>.<room>` in `localStorage`, written
on every change (blank text removes it). One key per room, so two tabs writing in different rooms don't overwrite
each other. The room view restores it on mount. Ending the session (logging out, or another tab switching to someone
else) removes that user's drafts. Storage that is full or disabled only means no drafts.

### 22.4 Unread count in the favicon

`web/src/favicon.ts` sums the room list's badges (§18.4: not the open room, hidden or archived ones) and draws an SVG
favicon (a speech bubble in the app's gradient) with a red badge holding the count (`99+` past 99); the title becomes
"(3) Chat". `index.html` carries the plain icon, so the tab has one before the script runs.

While the tab is away (`document.visibilityState` is `hidden`, kept as `AppState.away` by `app.ts`), nobody is
reading the open room, so its new messages count too: `unread.ts` counts them live, keeps the server's count for it
on a refetch, and refetches when the tab goes away (after sending what was read) to catch messages that came in
unseen while scrolled up. The room list still shows no badge for it (§18.4). Coming back, the room view reads what is
on screen as usual, which clears it; scrolled up, it stays out of the count, as before.

### 22.5 Focus on entering a room

When the composer is first shown in a room (on entering it or switching from another), the caret goes into it. Not on
touch screens (`(hover:none)`), where it would open the keyboard over the messages.

### 22.6 Confirmations go away

"Message forwarded." / "*n* messages forwarded." clears itself after 4 s (`NOTICE_MS`), unless another notice replaced
it meanwhile. Errors stay until something else is said.

### 22.7 Jump to latest

The pill over the bottom of the list (§7.5) also shows, as a quieter "↓ Jump to latest", whenever the newest messages
aren't on screen with nothing new below: scrolled up by more than 80 px, or the window is back in history (after a
quote or Jump to beginning). Clicking it scrolls to the bottom, or loads the latest page when the window doesn't have
it. "↓ New messages" and "New messages · Jump to latest" take precedence as before.

### 22.8 Tests

- **Integration** (`accounts.test.ts`): names unique across case, invisible characters and whitespace; renaming onto
  someone's name refused, keeping yours fine, a freed name can be taken; the key hidden and not settable; legacy
  shared names still save; the password route needs a session, checks the current and new passwords, changes it,
  answers with a working token, and signs out other sessions.
- **Unit**: `passwordProblem`; the profile's password form (local checks, wrong current password, success) and Log
  out; a taken name on sign up and on the profile; drafts across a reload, per user, cleared; focus on entering a
  room (not on touch screens); Jump to latest scrolled up and back in history; the forward confirmation going away;
  the favicon's label, count and title, with the open room counted while the tab is away (`favicon.test.ts`,
  `unread.test.ts`, `app.test.ts`).
- **E2E** (`accounts.spec.ts`): change the password and log in with it; a taken name at sign up; a draft survives a
  reload and the composer has focus on entering rooms; the title and favicon count unread messages; Jump to latest;
  the forward confirmation going away.

## 23. Room access: private rooms and Open Air

A room's creator chooses who can see it. Three levels, shown everywhere with the same names and icons
(`VISIBILITY` in `web/src/lib/rooms.ts`):

| Visibility | Icon | Who can read | Who can post |
|---|---|---|---|
| **Private** | 🔒 | its members: the creator and the people they added | its members |
| **Public** (the default, and every room from before) | # | everyone with an account | everyone with an account |
| **Open Air** | 🌐 | anyone, even without an account, while the room isn't archived | everyone with an account |

In any of them but a DM, the creator may also narrow who posts to the people they choose (§23.6).

"Open Air" is the name for a room that is readable from the open web: like a talk in the open air, anyone walking by
can listen in, but you need to step up (sign in) to speak.

### 23.1 Data model and rules

`rooms.visibility` (select `public` / `private` / `open`, required) is new; the migration
(`1760000014_room_access.js`) backfills `public`, and `private` for DMs, which are private to their two members.
`rooms.members` (§16.1) now holds up to 100 users (`LIMITS.roomMembers`), and also lists a private room's members.
The rooms hooks keep it consistent on every save (`setMembers` in `pb_hooks/lib/rooms.js`): a private room always lists
its creator first, each member once; any other room lists nobody (switching away from Private drops the list).

With `MEMBER(r)` = `@auth && (r.visibility != "private" || r.members.id ?= @auth || r.created_by = @auth)`:

| Collection | Rule | Value |
|---|---|---|
| `rooms` | list / view | `(visibility = "open" && archived = false) \|\| MEMBER("")` |
| `rooms` | create | as before; `visibility` may be set, `members` may not (a private room starts with its creator) |
| `rooms` | update | as before (creator only, never a DM), but `members` may now be sent; the hooks check it |
| `messages` | list / view | `(room.visibility = "open" && room.archived = false) \|\| MEMBER("room.")` |
| `messages` | create | `MEMBER("@request.body.room.")` instead of §16.3's condition |
| `messages` | update | as before `&& MEMBER("room.")`: someone taken out of a private room can't edit or delete what they wrote there |
| `hidden_rooms` | create | `MEMBER("@request.body.room.")` |
| `users` | view | `""` (anyone): guests see who wrote a message (`expand=author`: name and avatar; never the email). Listing and searching users still needs a session, so nobody can enumerate the accounts. |

Routes and hooks that check a room themselves use `canSee()` in `pb_hooks/lib/access.js`, which mirrors the view rule:
marking a room read, the unread counts' SQL, and the defense-in-depth check in `beforeMessageCreate` (§16.3). The
reaction, delete and forward routes already check the view rules. Attachments are protected (§17.3) and PocketBase
checks the message's view rule for them, so a guest downloads an Open Air room's files without a file token and
nobody else's.

### 23.2 Changing who can see a room

Only the creator, through the rooms API: `api.setAccess(id, visibility, members)` sends both (members only for
Private). In the room header's menu, the creator gets **Room access…**, a modal dialog (`views/room/access.ts`):
three radio cards, **+ Add people** (the user search of §16.5) above a member list with Remove buttons (not for the
creator), a warning that says what the change does ("Everything ever written here … becomes readable by anyone on the
web", "Everyone else loses it from their list", …), and Save/Cancel. The body scrolls between the title and the
buttons, so a long member list or search never pushes them away. Search results are toggles: someone already in shows
"✓ Added", and picking them takes them out again. Telegram stand-ins (§26.3, `no_dms`) are in neither the list nor the
search, since the bridge adds them itself; saving keeps them as members. Escape in the people search closes the search,
not the dialog. In a private room, the other members get **Members (*n*)**: the same dialog, read-only. The new-room
form has a "Who can see it" select, Public by default.

### 23.3 Guests

Without a session the app no longer starts on the login screen. Every route but `/me` is public; `/login` and
`/signup` are only for guests (`guestOnly`). A guest gets:

- the app bar with **Log in** and **Sign up**;
- the room list with only the Open Air rooms (the server lists nothing else to them), without menus, the new-room form,
  DMs, Hidden or Archived;
- rooms read-only: no composer but "You're reading as a guest. Log in or sign up to join the conversation.", no message
  actions, reactions shown but not clickable, no "Message" on authors, and only "Jump to beginning" in the menu;
- a room they can't see says "This room doesn't exist. Log in to see more rooms, …".

Nothing that needs an account is asked for: no unread counts, hidden rows, file tokens or user lookups. Logging in (or
signing up) from a page goes back to that page; logging out goes home as a guest (an expired or revoked session goes
to the login page instead, and back once logged in). Whoever logs in after a logout starts from home (QA BUG-59).
When the session changes to another user or to none, the realtime connection is closed and a new one opened: on the
old one, PocketBase would refuse the new subscriptions and go on sending the previous user's events (QA BUG-66).

### 23.4 Losing (and regaining) access live

PocketBase only sends a record change to the clients that can see the result, so nobody would hear of a room they
can no longer see. After a room is saved, `dropLostAccess()` (`pb_hooks/lib/access.js`) goes through the realtime
clients and sends each one that could see the room before but can't now a `delete` event, with only the id, on its
rooms subscriptions. Saves that don't change access return early (every DM message saves its room). Gaining access
needs nothing new: the update event reaches the new viewer.

On the client, a room that leaves the store while it is open replaces the room view with "You can't see this room any
more." (the messages go too). If it comes back (re-added, unarchived, opened again), or a room shown as "doesn't exist"
becomes visible, the page starts over and shows it (`ctx.reopen`, QA BUG-60). A room that appears (e.g. you were added)
refreshes the unread counts.

### 23.5 Tests

- **Integration** (`room_access.test.ts`): who sees, posts, reacts, forwards, hides and marks read in each kind of room;
  members kept consistent (creator always, deduplicated, cleared off Private, 100 at most, unknown users refused, DMs
  unchanged); only the creator changes access; a removed member can't edit, delete or download; guests read Open Air
  rooms with authors, attachments and live messages, and nothing else; archived Open Air rooms hidden from guests;
  delete events for losing access, update events for gaining it, nothing for anyone else; filters, expands and
  subscriptions by id don't reach into a private room.
- **Unit**: the guest app (Open Air list, header links, no session calls, `/me` asks to log in), a guest reading a
  room, logging in from a room goes back to it; the header's items; the dialog (making a room private, adding and
  removing people, warnings, a failed save, read-only members); losing and regaining access; markers and the visibility
  select in the room list; a guest's room list; QA BUG-61.
- **E2E** (`room_access.spec.ts`): a private room created from the sidebar, a member added in the dialog sees it live,
  others never do, the member sees the read-only list, and is taken out while reading it; a guest reads an Open Air
  room live with its picture, can't write, is told about a room that needs an account, and logs in back into the room;
  an Open Air room leaves and comes back on a guest's screen as it is archived, unarchived and made public. axe checks
  the dialog.

### 23.6 Who can post

Seeing a room and posting in it are two choices. `rooms.posting` (select `everyone` / `selected`, required;
migration `1760000023_room_writers.js` backfills `everyone`) says who posts: everyone who can see the room (as
before; guests never), or only `rooms.writers` (up to 100 users). The hooks (`setWriters` in
`pb_hooks/lib/rooms.js`) keep it consistent on every save: a DM always lets both post; writers are listed only while
posting is `selected`, the creator first, each once, and in a private room only its members (a member taken out stops
being a writer). Writers can't be set when creating a room; only its creator sets them afterwards (the rooms update
rule).

With `WRITER(r)` = `r.posting != "selected" || r.writers.id ?= @auth || r.created_by = @auth`:

| Collection | Rule | Value |
|---|---|---|
| `messages` | create | as in §23.1 `&& WRITER("@request.body.room.")` |
| `messages` | update | as in §23.1 `&& WRITER("room.")`: as in an archived room, someone who may no longer post can't edit or delete what they wrote there (put back, they can) |

Reacting only needs to see the room: readers react. `canWrite()` (`pb_hooks/lib/access.js`) mirrors the rule in
`beforeMessageCreate`, so forwards into the room (`POST /api/chat/forward`) and anything else the app saves are held
to it too, and in `POST /api/chat/delete`. Telegram stand-ins (§26.3) who speak in a linked room are made writers, as
they are made members of a private one: the Telegram group decides who speaks.

On the client, `canPost(room, me)` (`web/src/lib/rooms.ts`) decides. Someone who can see but not post gets "Only some
people can post in this room. You can read along and react." instead of the composer (what they had typed is kept),
no Reply, Edit or Delete, and doesn't get the room as a forward target; Forward and Select stay, to share its messages
elsewhere. A change of writers reaches everyone in the room live (the room's update event), so the composer comes and
goes as it is saved. The access dialog has a second choice under the visibility, **Who can post?**: "Everyone who can
see it" or "Only people you choose", which shows a **Who can post** list like the members list (+ Add people, Remove;
the creator stays). In a private room its search offers only members, and taking someone out of the members takes
them off it too. Members of a private room see the list read-only.

Tests: `room_writers.test.ts` (integration: defaults, who posts, reacts and forwards, a writer taken off, private
rooms, DMs, limits), `api.test.ts` (`setAccess` with writers), `telegram.test.ts` (stand-ins become writers),
`access.test.ts` (unit: the dialog, a reader's room, made a writer live) and `room_access.spec.ts` (e2e, with axe).

## 24. Site settings: branding and invite-only signups

An admin (a PocketBase superuser) sets the site's title and logo, and can make signing up need an invite code. There
is no admin page in the app: it is all in the PocketBase admin UI (`/_/`, *Collections → site*).

### 24.1 Data model and rules

`site` (migration `1760000015_site.js`) holds one record, created by the migration:

| Field | Type | Notes |
|---|---|---|
| `title` | text, required, 1–48 | Shown in the app bar, on the login page and in the tab's title. "Chat" at first. |
| `logo` | file, optional | SVG, PNG, JPEG, WebP or GIF, up to 1 MB, public. Replaces the app bar's speech bubble and sits above the title on the login page. |
| `invite_only` | bool | Signing up needs `invite_code`. |
| `invite_code` | text, **hidden**, ≤ 100 | Only superusers see it. Empty while invite-only: signups are closed. |

List and view rules are `""` (anyone, guests too: the login page needs the branding and whether to ask for a code);
create, update and delete are superusers only. Should a second record be added, the oldest one counts. PocketBase
serves files with a `sandbox` Content-Security-Policy, so an SVG logo can't run scripts even opened on its own.

### 24.2 Invite-only signups

`checkInvite()` (`pb_hooks/lib/site.js`, a users create-request hook) runs before the record is validated. While the
site is invite-only, the request must carry `invite_code` (not a users field, so PocketBase doesn't store it) equal to
the site's, ignoring spaces around it and compared in constant time; otherwise a 400 on `invite_code`:
`validation_required` (none sent), `validation_invalid_invite` (wrong, case-sensitive) or `validation_signups_closed`
(the site has no code). Superusers create accounts as before (the admin UI). Existing accounts log in as before. OAuth2
(off, §14) can't create accounts while invite-only either: `checkOAuth2Signup()` refuses them. The signup rate limit
(§5) also limits guessing.

### 24.3 Frontend

`api.site()` reads the record (`id,title,logo,invite_only`) and `startSite()` (`web/src/site.ts`) puts it in the store
as `site` at startup: the app bar's brand, the login page's heading and the tab's title (§22.4) follow it. It stays when
the session ends. The last one seen is kept in localStorage (`chat.site`), so a reload shows the site's own branding
at once; a failed load keeps what is shown. On the Sign up tab of an invite-only site, an **Invite code** field comes
last, and its errors show next to it. A site made invite-only after the page loaded still refuses the signup, with the
server's message above the button.

### 24.4 Tests

- **Integration** (`site.test.ts`): one public record without its code; only superusers change it; the logo is a public
  image and an SVG one is sandboxed; signups open, needing the code (missing, wrong, wrong case, padded), and closed;
  existing accounts still log in and superusers still create accounts.
- **Unit**: loading, caching and failing to load the site (`site.test.ts`); the app bar, login page and tab title with
  a custom site, kept after logging out; the invite code field, what it sends and its errors (`login.test.ts`).

---

## 25. Measured scale

`tests/perf/scale.ts` seeds a throwaway server and times, through the app's own client, the requests whose cost grows
with the data (`node --experimental-eventsource --no-warnings tests/perf/scale.ts`; sizes from `ROOMS`, `USERS`,
`MESSAGES`, `LISTENERS`). Measured 2026-10-13 on the dev machine (AMD Custom APU 0405: a Steam Deck, 4 cores /
8 threads), 100,000 messages, every room with ≥ 100 unread for the caller (the worst case for §18.2: each count stops
at 100):

| Request | 200 rooms, 50 listeners | 1,000 rooms, 200 listeners |
|---|---|---|
| `GET /api/chat/unread` (§18.2) | 52 ms | 237 ms |
| List rooms | 19 ms | 80 ms |
| Latest page of a room (50 messages) | 10 ms | 10 ms |
| Send a message | 5 ms | 5 ms |
| Send, until every listener has the event (§18.3) | 34 ms | 82 ms |

- **Linear in what grows:** unread counts ≈ 0.24 ms per visible room (worst case), the room list ≈ 0.08 ms per room,
  a message's fan-out ≈ 0.4 ms per connected listener (every open signed-in tab listens to every room it can see).
  Pages and sends don't depend on the size.
- **First to matter:** the unread counts, fetched on load, on every reconnect and after reads elsewhere (debounced).
  Around 4,000 visible rooms one fetch would take about a second of server time; then count only rooms with activity
  since the caller's oldest read, or keep counts per user. Next, the fan-out: at hundreds of open tabs, each message
  costs tens of ms of server time; a thinner event or batching would help (REFACTOR item 26).

## 26. Telegram bridge

A Telegram bot joins Telegram groups, and each group can be linked to a room. What is written on either side shows on
the other, files included, so people in the room and people in the group talk to each other.

### 26.1 A module apart

The bridge is `pb_hooks/telegram.pb.js` (it registers everything), `pb_hooks/telegram/` (its code: PocketBase only
runs `*.pb.js` files, so these load only when required) and its own collections, `tg_*`
(`pb_migrations/1760000019_telegram.js`). Nothing in the app refers to it. It reads the app's records, and saves
messages and users through the same hooks as everything else, so trimming, limits, access checks, unread counts and
realtime work for its messages unchanged.

- **On:** `TELEGRAM_BOT_TOKEN` is set. Unset, `telegram.pb.js` registers nothing (the `tg_*` collections stay, empty).
- **Removed:** delete `telegram.pb.js` and `telegram/`. Going down the migration drops `tg_*`. Stand-in users and their
  messages stay, as any user's do.
- **Core changes it needed** were made for themselves: `users.no_dms` (§16.7), and attachments of 10 × 20 MB (§17.1),
  the size of a Telegram album and of the largest file a bot may download.

### 26.2 Settings

All from the environment (`telegram/api.js`):

| Variable | |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the bot's token from @BotFather |
| `TELEGRAM_WEBHOOK_URL` | this server's public `https://…/api/telegram/webhook`. Unset, the bridge polls (development) |
| `TELEGRAM_WEBHOOK_SECRET` | what Telegram sends with each update; derived from the token when unset |
| `TELEGRAM_API_BASE` | the Bot API server, `https://api.telegram.org` by default (tests point it at a stub) |

On `serve`, the bridge calls `setWebhook` (the URL, the secret, `max_connections: 1` so updates come one at a time
and in order, and only `message`, `edited_message`, `channel_post`, `edited_channel_post` and `my_chat_member`), or, without a URL, `deleteWebhook` (a bot
with a webhook can't poll). The bot needs **privacy mode off** (@BotFather → `/setprivacy` → Disable) or to be a group
admin, or it sees only commands.

A **channel** links like a group. The bot must be one of its admins (with *Post messages*, to send to it). Its posts
and their edits come as `channel_post` / `edited_channel_post` and show under the channel's stand-in.

### 26.3 Telegram people in the chat

Each Telegram sender (or chat posting as itself: an anonymous admin, a channel) gets a **stand-in user** on their
first message (`tg_people` maps the Telegram id to it):

- Named after them with " (TG)": "Ann Lee (TG)", "Ann Lee 2 (TG)" if taken (names are unique, §22.1), within the 32
  characters. A Telegram name change renames it. While the bridge is on, " (TG)" is theirs alone: signing up or renaming
  to a name ending in it ("(tg)", full-width or spaced too) is refused for anyone but a superuser (QA BUG-86).
- Their Telegram profile picture as its avatar, checked again at most once a day.
- `no_dms` set (§16.7): nobody can open a DM with them, and their names have no **Message** menu.
- An address at `telegram.invalid` and a random password: nobody can log in as one.
- They appear in user search like anyone (e.g. to add them to a private room). A stand-in writing in a private room is
  made a member of it, as the messages hook requires (§23).

### 26.4 Telegram → chat

`POST /api/telegram/webhook` (the secret checked, in constant time; any update that fails is logged and answered 200, so Telegram
doesn't hold the next ones back) or polling hands each update to `inbound.js`:

- **A message** in a linked group becomes a message of its sender's stand-in: the text or caption ("↪ Forwarded from
  X" above a forward), and the files, downloaded from Telegram (`getFile`) and saved like uploads: photos (the largest
  size), videos, documents, audio, voice, video notes, GIFs, static stickers. A file over 20 MB, an animated sticker, a
  location, a contact, a poll or a dice becomes a line of text saying what it was. Text is cut to 2000 characters.
- **A reply** to a message the bridge knows (either way) replies to it in the room.
- **An album** comes as one update per item. The items wait in `tg_queue` and become **one message** (up to 10 files,
  the caption as its text) when the next update from that group comes, or when the album has been quiet for 1.5 s (the
  worker checks every second).
- **An edit** edits the message's text. Telegram doesn't tell bots about **deletes**, so a message deleted in Telegram
  stays in the room (a known limit).
- The same update delivered twice (a webhook retry) comes over once (`tg_messages` knows it).
- The message and what it maps to are saved in one transaction, so the worker never sees a message from a group
  without knowing it came from there.
- Joins, leaves, pins and title changes are left out, as is any service message with nothing to show (a new group
  photo, a timer, a topic): those make no stand-in (QA BUG-88). In a private chat with the bot, it says it works in groups.

### 26.5 Linking

`tg_links` has a row per group: `chat_id`, `title`, `room`, `enabled`. When the bot is added to a group (or first
hears from it) it makes the row, disabled and without a room, and posts the group's chat id. **A superuser links the
group in the admin UI** (*Collections → tg_links*): pick the room, tick `enabled`. `/chatid` (or `/start`) in the group
says whether it is linked. A DM can't be linked, a link can't be enabled without a room, and a group that removes the
bot is disabled. A room may be linked to several groups: each one's messages go to the others too. A group that
becomes a supergroup (a new chat id) keeps its link and its queue, whichever of Telegram's two notices (in the old
group, in the new) comes first (QA BUG-89). An archived room, or a disabled link, passes nothing either way.

The room says when a group starts or stops passing messages to it, in a service message (§5.3): "Telegram group "Friends" was connected to this room." when a link gets enabled with a room (created so, ticked, or moved to it), "… was disconnected from this room." when it stops (unticked, moved to another room, or deleted), and "… was disconnected from this room: the bot was removed from the group." when the group removes the bot. An archived room is told nothing. A title change or a group becoming a supergroup says nothing. The title is tidied like a name (no bidi overrides or line breaks), and a blank one reads "A Telegram group". The same news delivered twice at once (the bot removed, a link unticked) tells the room once: the link is read again in the save's transaction.

### 26.6 Chat → Telegram

The messages hooks only **queue** the work (`tg_queue`, in the same transaction as the save): a new message, an edit
of the text, a delete, for each group the room is linked to. The worker sends it, so nobody's request waits for
Telegram (`outbound.js`):

- **The message** goes as the bot, with the author's name in bold over the text (Telegram HTML, escaped): "**Bob**
  hello". A forward says "*forwarded from Ann*" and shows its original's text and files (§21.3).
- **Files:** photos (jpg, png, webp up to 10 MB, Telegram's photo limit) and videos (mp4, m4v, mov; sent with `supports_streaming`, so they play inline as they load) go together as an album,
  other files as a second album of documents (Telegram doesn't mix them); one file goes alone. The text is the first
  item's caption when it fits (1024 characters), else a message of its own before the files. Files keep their original
  names.
- **A reply** replies to the Telegram message of what it answers, when that is in the group.
- **Edits** edit the Telegram message holding the text (or the caption, its text cut to 1024 characters with "…" when
  the edit made it longer: QA BUG-87). **Deletes** delete the Telegram messages;
  bots can delete their own only for 48 hours, so an older one is edited to "*Message deleted*" instead.
- A message from a group isn't sent back to it.
- Not passed on: reactions, service messages (§5.3), and a forward's later changes when its original is edited.

### 26.7 The worker

A cron job (`* * * * *`) starts `worker.js`, which runs for 57 s, once a second: it brings over albums that are
complete, then sends what is queued, oldest first (polling Telegram first, when there's no webhook). One run at a time
(a lock in the app store). A failure that may pass (no answer, 5xx, 429) is retried after `retry_after` or 2, 4, 8…
seconds, up to 8 tries, and holds back that group's later items so they arrive in order; one Telegram refuses for good
(4xx) is dropped and logged. `POST /api/telegram/tick` (superusers) runs one pass at once. A message whose send fails
halfway (some of its files sent) isn't sent again.

### 26.8 Tests

`tests/integration/telegram.test.ts` starts its own PocketBase with the bridge on, against a stub Bot API
(`tests/support/telegram.ts`: records calls, serves files, queues updates, fails on demand). The harness never passes
the developer's own `TELEGRAM_*` variables to a test server. Covered: setWebhook and the secret; a new group's link
and `/chatid`; links only for rooms; a stand-in (name, picture, `no_dms`); files, an album as one message (by the next
update, and once quiet), files too large; replies, edits and a repeated delivery; a stand-in joining a private room; a
message, reply, edit and delete going out; service messages for a group connected, disconnected, moved, deleted and removing the bot; files going out as an album with a caption plus documents; a room linked to
two groups; retries in order and dropping; nothing while disabled or archived; polling.

---

## 27. Installable app (PWA)

The app can be installed (Add to Home Screen, the browser's Install button) and opens offline to its shell. No push
notifications and no offline data: what the server says is fetched as before (the room cache, §7.5, only shows
a room's last page while it loads; it isn't used offline).

### 27.1 Manifest and icons

- `GET /manifest.webmanifest` (`manifest()` in `pb_hooks/lib/site.js`) is built per request: `name` and `short_name`
  are the site's title (§24), so the installed app is named like the site. `start_url` and `scope` are `/`,
  `display: standalone`; `theme_color` is the app bar's (`--surface`) and `background_color` the page's (`--bg`),
  light theme (a manifest has one of each). `application/manifest+json`, `no-cache`, like every page (§5.6).
- **Icons** (`web/public/icons/`, copied to `pb_public/icons/` by `build` and `dev`): the speech bubble as `icon.svg`,
  192 and 512 px PNGs, a 512 px maskable one (the bubble inside the safe zone, on `--surface`) and a 180 px
  `apple-touch-icon.png` for iOS (opaque: iOS fills transparency with black). The site's logo isn't used: it may be
  any image, an SVG or a small one, and an installed app needs square PNGs.
- `index.html` links the manifest and the Apple icon, and sets `theme-color` for light and dark.

### 27.2 Service worker

`web/src/sw.ts` is built on its own (`SW_OPTIONS`, an unhashed IIFE) to `/sw.js`, which must sit at the root to
control every page; it is served `no-cache`, so a new one is found on the next load. `main.ts` registers it. A new
worker takes over at once (`skipWaiting`, `clients.claim`): it holds nothing an open page relies on.

- **Pages** (navigations): network first, so a deploy shows on the next load. Each HTML page fetched is kept (every
  page of the app is the same `index.html`, §7.1), and offline the last one kept is served.
- **Content-hashed assets** (`/assets/*-HASH.js|css`): cache first; one name never changes. Keeping a new page drops
  the cached assets it doesn't name (older builds; a lazy chunk comes back when used).
- **Attachment thumbnails** (`GET /api/files/messages/{id}/{file}?thumb=…&token=…`): cache first, in their own cache
  (`chat-files`), kept under the URL without the token plus the token's user id (read from the JWT, not verified:
  the server checks a miss). A file name never changes its content, so a kept thumbnail is never stale. Only
  successes are kept, at most 1000 (oldest out first, trimmed every 50th put). A request with no file token (a
  guest) is left to the browser. When the session ends (logout, a user switch, an expired session), `app.ts`
  deletes the cache, like the room cache (§7.5): a shared computer doesn't keep the last user's pictures. Losing
  access to a room doesn't evict its thumbnails, but the app no longer lists its messages, so nothing asks for them.
- **Everything else** is the browser's: `/api/` (records, realtime, full files: nothing stale and nothing else
  private cached), `/_/`, other origins, anything but `GET`, and unhashed dev assets.

Offline the shell boots and behaves as with the server unreachable: failed loads show their errors and **Retry** (§7.5),
and realtime reconnects when the network is back (§6).

### 27.3 Tests

- **Integration:** the manifest is named after the site and lists its icons (`site.test.ts`); `/sw.js` is served
  `no-cache` (`http.test.ts`).
- **E2E** (`pwa.spec.ts`, Chromium): the manifest and every icon load with the right type; once the worker controls
  the page, a page loaded offline still shows the app. A thumbnail is kept once and then served for another token of
  the same user (one the server refuses), not for another user's; logging out deletes the cache. Other specs run with service workers blocked
  (`playwright.config.ts`): the worker fetches hashed assets itself, out of reach of `page.route()`.

---

## 28. Link previews

Under a message, a line for each link in its text: the page's favicon and title, opening the link in a new tab like
the link in the text (§7.6.3).

### 28.1 Data and the worker

- **`messages.previews`**: `[{ url, title, icon }]`, in the order the links come in the text. `icon` is a `data:` URL
  ("" when there is none), so nothing is hotlinked (the CSP allows only `data:` and the app's own images) and nobody's
  browser tells a site who reads the room. Set by the server only: create and update rules refuse it in a body, the
  hooks set `[]` on create, on an edit of the text and on delete, and an edit keeps the stored ones otherwise (as for
  reactions, §20.2). A forward shows its original's (`showOriginal`), and gets saved again when they arrive, like an
  edit of its original (§21.3).
- **Queue:** a new message with links, or an edit of the text, adds a `link_queue` row in the save's transaction.
  A cron job (`* * * * *`) runs `pb_hooks/lib/previews.js` for 57 s, once a second (one run at a time, a lock in the
  app store); `POST /api/previews/tick` (superusers) runs it at once. Each message: its links (found as `linkify`
  finds them, each once, at most 5), fetched one at a time; the previews are saved in a transaction unless the text
  changed meanwhile (the edit queued it again). Everyone sees them live, as an update. A link that fails gets no line
  and isn't tried again.
- **Fetching:** the page with `Range: bytes=0-262143` (4 s timeout), `text/html` only, its UTF-8 or Latin-1 text.
  The title is `og:title`, else `<title>`, entities decoded, whitespace collapsed, at most 200 characters; no title,
  no line. The icon is the first `<link rel="… icon …">`, else `/favicon.ico` (3 s), an image of at most 16 KB, its
  type as served or sniffed (PNG, ICO, GIF, JPEG, SVG).
- **Where the server may go** (server-side request forgery): http(s) on the default port, a public IPv4 address or a
  name with a dot whose last label is letters and isn't a local one (`localhost`, `.local`, `.internal`, `.lan`,
  `.home.arpa`…); no userinfo, no IPv6 literals, no single-label names (Docker service names). The JSVM can't resolve
  names, so a public name pointing at a private address, or a redirect to one, gets through: what could come back is a
  page's title and a small image, never its body. `$http.send` reads a whole response, so a server that ignores
  `Range` is read until the timeout.
- **Settings:** `LINK_PREVIEWS=off` turns it off (test servers default to off, so tests never fetch what they link
  to). `LINK_PREVIEWS_ALLOW_HOSTS` (comma-separated `host` or `host:port`) lets hosts through the checks: tests.

### 28.2 Frontend

`MSG_FIELDS` asks for `previews`. Under the text and attachments, `ul.previews`: per line an `<a>` (same `target` and
`rel` as text links, the URL as its title) with a 16 px `<img alt="">` and the title, one line cut with an ellipsis.
Only `http(s)` URLs and `data:image/` icons are shown. An edit clears them at once (optimistic), until the new ones
come.

### 28.3 Tests

- **Integration** (`previews.test.ts`, its own PocketBase with previews on, a stub site): titles (og:title first,
  entities, Latin-1) and icons (the page's, `/favicon.ico`, too big); each link once; no line for an untitled page or a
  PDF, none past the 5th link; clients can't set them; an edit replaces them and a delete clears them; a forward shows
  its original's; local and private addresses are never fetched.
- **Unit** (room view): lines with favicon and title; a `javascript:` URL and a non-`data:` icon left out; titles as
  text.
