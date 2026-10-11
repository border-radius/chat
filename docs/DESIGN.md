# Chat — MVP Design Document

| | |
|---|---|
| **Status** | Draft |
| **Date** | 2026-10-10 |
| **Scope** | MVP (§1–§14); post-MVP features: avatars §15, direct messages §16, attachments §17, unread counts §18 |

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
- Reactions, threads, replies, mentions
- Typing indicators, presence, read receipts
- Push notifications, email notifications
- Message search
- OAuth providers (email and password only)
- Email verification (not required to sign up or post, so no SMTP needed)
- Message retention limits (history is never pruned)
- Native mobile apps, offline support, service worker
- End-to-end encryption

## 3. Architecture

```
┌────────────────────────── Browser ───────────────────────────┐
│  index.html + app.[hash].js + app.[hash].css                 │
│                                                              │
│  router ─► views (login / rooms / room) ─► dom helpers       │
│              │                                               │
│              ▼                                               │
│            store  ◄──── api.ts (wraps PocketBase JS SDK)     │
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
│   ├── QA.md                   # QA findings for §15–§17 (BUG-24 …)
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
│   └── 1760000005_file_names.js        # §17.1 (QA BUG-28)
├── pb_hooks/                   # server-side JS hooks (committed)
│   ├── main.pb.js              # registrations only
│   └── lib/
│       ├── chat.js             # validation, stamps, soft delete, DM guards, headers (§5.6, §16, §17)
│       ├── dms.js              # POST /api/chat/dms (§16.2)
│       └── images.js           # upload image size limit (§15, QA BUG-24)
├── web/
│   ├── index.html              # template; build injects hashed asset names
│   ├── styles/app.css
│   └── src/
│       ├── main.ts             # boot
│       ├── app.ts              # app shell: session, routes, app bar
│       ├── api.ts              # the only module that imports the PB SDK
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
│       │   └── token.ts        # file token cache (§17.3)
│       ├── ui/                 # small reusable components
│       │   ├── menu.ts, avatar.ts, user-search.ts
│       └── views/
│           ├── login.ts, rooms.ts, home.ts, profile.ts
│           ├── room.ts         # puts the controller's changes on screen, wires the parts
│           └── room/           # controller.ts (message window, loading, realtime, sending; no DOM),
│                               # header.ts, messages.ts (the list), composer.ts
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
| `author` | relation → users | required, single |
| `text` | text | max 2000 chars. Must be non-empty unless the message is deleted (enforced by a hook, §5.6), so not marked `required` in the schema. |
| `edited_at` | date | empty = never edited; set by a hook when `text` changes on update |
| `deleted` | bool | default `false`; once true it can never be set back to false |
| `deleted_at` | date | set by a hook when `deleted` becomes true |
| `created` / `updated` | autodate | |

**Messages are soft-deleted.** When a user deletes a message, the record stays in place. The server sets `deleted = true`, stamps `deleted_at` and **clears `text`**, so the content really is gone from the database and from every API response.

Clients render a deleted message as a *"Message deleted"* placeholder, with its author and time kept. This keeps conversations readable, so replies still make sense and history doesn't silently shrink. A deleted message can't be edited or undeleted.

The API `DELETE` endpoint is turned off, so records are never removed. The only exception is a superuser using the admin UI.

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
- stays reachable by direct link `#/r/:id`, and posting still works there.

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

² Users can't delete their own account: their messages and rooms reference them through required relations, so the delete could only fail for anyone who had posted. Removing an account (and deciding what happens to its content) is a superuser task for now.

The source of truth for all rules is `pb_migrations/1760000000_init.js` and the migrations after it. Direct messages (§16.3) change the `rooms` and `messages` rules above; this table is the MVP version.

PocketBase applies the list rule to realtime subscriptions too, so these rules also control who receives SSE events.

In plain terms:

- Any logged-in user can create a room.
- Only the creator can rename, archive or unarchive it.
- Only the author can edit or delete a message, and only while its room is active. "Delete" is an update that sets `deleted: true`. After that the message is frozen.
- `hidden_rooms` rows are visible only to their owner.

### 5.6 Server hooks (`pb_hooks/main.pb.js`)

The hooks are kept small. They only do things the rules can't express:

- **Normalize text:** trim `messages.text`, `rooms.name` and `users.name` on create and update, and reject values that are empty after trimming or made only of invisible characters (zero-width spaces, bidi controls, BOM…). Names also lose bidi overrides and zero-width spaces, so they can't be used to spoof another name. The one exception is message text on a delete (next bullet).
- **Unique room names:** on `rooms` create and update, set `name_key` and reject a name whose key another room already has (`validation_not_unique` on `name`, like the index error it replaces).
- **Soft delete:** on a `messages` update where `deleted` becomes true:
  - set `deleted_at = now` and `text = ""`;
  - ignore any other fields in the same request;
  - leave `edited_at` unchanged.
- **Edit stamp:** on a `messages` update where `text` actually changed (and it isn't a delete), set `edited_at = now`. An update that doesn't change the text leaves it untouched.
- **Archive stamp:** on a `rooms` update, set `archived_at = now` when `archived` becomes true, and clear it when `archived` becomes false.
- **Archived-room guard (defense in depth):** reject a message create, update or delete when the target room is archived. This repeats the API rule in case rule traversal through `@request.body.room.archived` behaves differently in the pinned PocketBase version. Integration tests cover both layers.
- **Security headers** via `routerUse`: every response gets `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. Static app paths also get `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The CSP is *not* applied to `/api/*` or to the admin UI `/_/`, which sends its own CSP.
- **Cache headers:** `/assets/*` (content-hashed) gets `Cache-Control: public, max-age=31536000, immutable`. Every other static path, including `/` and `index.html`, gets `no-cache`.
- **Rate limiting:** PocketBase's built-in limiter, enabled from the init migration. The limits are per client IP:
  - `messages:create`: 10 requests per 5 s.
  - `users:create` (guests): 20 requests per 60 s.
  - `messages:update` (edits and soft deletes): 20 requests per 10 s.
  - `rooms:create`: 5 requests per 60 s (rooms can't be deleted, so a flood would stay in everyone's list).
  - PocketBase's default rules are kept after these.

  Test harnesses turn the limiter off, because every test client shares 127.0.0.1. `http.test.ts` turns it back on to verify the 429.

## 6. API usage (frontend ↔ backend)

The frontend uses the official **PocketBase JS SDK**. It has no dependencies, is roughly 10 KB gzipped, and handles auth token storage and refresh, SSE reconnects, and request cancellation. Only `api.ts` imports it, so it could be replaced later.

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
| One message (open `#/r/:id/m/:msgId`) | `messages.getOne(id, {expand: "author", fields: MSG_FIELDS})`, then an older and a newer page around it |
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

### 7.1 Screens and routes (hash router)

| Route | View | Notes |
|---|---|---|
| `#/login` | login / signup (tabbed form) | redirected here if not authenticated |
| `#/` | room list + "new room" form, with a greeting where a room would be | on narrow screens only the room list shows |
| `#/r/:roomId` | room: message list + composer | on wide screens the room list stays visible as a sidebar |
| `#/r/:roomId/m/:msgId` | room, opened at a specific message (window centered on it) | used by "jump to beginning" and shareable later |

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

A hash router means PocketBase serves `index.html` for `/` with no server-side catch-all needed. The router is about 40 lines. It parses `location.hash`, matches against a small route table, calls the current view's `unmount()`, then calls the next view's `mount(el, params)`. When the next route uses the same view factory and the mounted view has `update(params)`, the router calls that instead. The room page uses this to swap only the room pane, so the sidebar stays mounted while switching rooms.

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

This is a typed event emitter around a plain object: `{ user, rooms: Map, hidden: Map<roomId, hiddenRowId>, roomsStatus, activeRoomId }`. Updates such as `upsertRoom(r)` and `markHidden(roomId, rowId)` live next to the store and replace maps rather than mutating them. `sync.ts` owns `rooms`, `hidden` and `roomsStatus` while someone is logged in: it loads both lists, holds the only `rooms` and `hidden_rooms` subscriptions, and reloads after each reconnect. The selector `roomSections(state)` splits rooms into Rooms, Hidden and Archived. It is a pure function and is unit-tested. Message lists are **not** kept in global state. Each room view owns its own `MessageList` model (§7.5) and throws it away on unmount, which keeps memory bounded.

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

**Reconnects:** the SDK reconnects SSE automatically. On every `PB_CONNECT` after the first, the room view checks where its window is:

- **At the live edge:** it fetches *newer than the newest loaded message* (by cursor, repeating until a short page comes back) and merges the results in. This fills the gap from the disconnect, however long it was.
- **Scrolled into history:** it fetches nothing newer, because the next newer-page fetch picks up the missed messages naturally.

In both cases it also refetches the messages *already in the window* that changed while it was disconnected (`updated` later than the newest `updated` it holds), so edits and deletes missed meanwhile apply: a deleted message must never keep showing its text. Sync refetches the room record, in case the room was archived meanwhile.

If the room's first load fails (other than "room not found"), the list shows an error with **Retry** instead of an empty history, the composer is hidden, and the load is retried by itself on the next reconnect.

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

### 7.7 Performance budget (enforced in CI, §9.4)

| Asset | Budget (gzipped) |
|---|---|
| `app.js` (including the PB SDK) | **≤ 30 KB** (25 KB for the MVP; raised for §15–§17, see §13) |
| `app.css` | **≤ 5 KB** |
| `index.html` | ≤ 1.5 KB |
| Web fonts | **none** (system font stack) |
| Requests on first load | 3 (html, js, css) + API |

Other rules:

- `<script type="module" defer>` in the `<head>` and `<link rel="stylesheet">`. No render-blocking third-party code.
- An inline app shell in `index.html` paints before the JS runs.
- The latest-messages fetch and the SSE subscribe start in parallel.
- `Intl.DateTimeFormat` instances are created once and cached.

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
| `pocketbase` | runtime | JS SDK |
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
// then: read metafile → rewrite web/index.html with hashed names → pb_public/index.html
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
- Unknown hash redirects to `#/`.
- Unauthenticated access redirects to `#/login`.
- `unmount` of the previous view is called before the next view's `mount`.

**`views/room.test.ts`** (real PocketBase)
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
- Successful login navigates to `#/`.

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
7. **Session persistence:** reloading the page keeps the user logged in. Logging out redirects to `#/login`, and going back does not show room content.
8. **Reconnect gap fill:** take B offline with `context.setOffline(true)`, have A send 80 messages (more than one page), bring B back online, and all 80 appear in order.
9. **XSS smoke test:** sending `<img src=x onerror=window.__pwned=1>` renders as literal text and `window.__pwned` stays undefined. The same holds after editing.
10. **Mobile viewport (390×844):** the room list collapses, the composer is visible above the keyboard area, and sending works.

### 9.4 Non-functional checks

- **Bundle budget:** the build fails if the limits in §7.7 are exceeded.
- **Accessibility:** run `@axe-core/playwright` on the login, rooms and room screens, with zero serious or critical violations (this adds a dev dependency only).
- **Performance smoke test (optional in CI):** Playwright with 4× CPU throttling. The time from navigating to `#/r/:id` until the first message is visible should be under 1.5 s on a local server.

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
| Spam and flooding | PocketBase rate limits, the 2000-char cap, and signup rate limiting. |
| Token theft | The token is stored in `localStorage` by the SDK. The CSP greatly lowers XSS risk. Moving to HttpOnly cookies is noted as future work. |
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
| Attachment layout | Images render in fixed-size boxes, so loading them never moves the scroll position (§17.5). |
| Metadata stripping | The client re-encodes JPEG/PNG/WebP images (PNG as PNG, the rest as JPEG) before upload, which drops EXIF (including GPS). Best effort, protecting honest users only (§15.3). |
| Bundle budget | `app.js` budget raised from 25 KB to 30 KB gzipped (§7.7): avatars + DMs measured 25.9 KB. One bundle, no lazy chunks. |

### Decided (2026-10-11, unread counts)

| Topic | Decision |
|---|---|
| Which rooms | Every room in the Rooms and Direct messages sections. Hidden and archived rooms still show nothing (§13 above), and neither does the room you are in. |
| What the badge shows | A count, shown as `99+` past 99. Your own messages and deleted messages never count. |
| Where read state lives | On the server (`room_reads`, §18.1), so it follows you across tabs and devices. |
| When a room is read | When the room view shows its latest messages, scrolled to the bottom, in a visible tab (§18.3). Scrolled up, new messages stay unread until you scroll down to them. |
| Before you joined | Messages older than your account never count, so a new user doesn't start with 99+ everywhere. |

### Still open

1. ~~**Unread state for DMs.**~~ Done for every room: §18.
2. **Upload quotas.** Rate limits cap the request rate, not stored bytes. A per-user storage cap (a hook summing file sizes) is deferred until real usage shows the need.

## 14. Future work (post-MVP)

Private rooms (§16's `kind` + `members`, allowing more than two members), blocking users, link previews, reactions, typing and presence (custom realtime channels via `$app.subscriptionsBroker()`), OAuth2 providers, message search (SQLite FTS5 through a custom route), a service worker for an offline shell, and HttpOnly cookie auth.

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
- **App bar:** the user's own avatar (24 px) next to their name. Both open `#/me`.
- A failing avatar image (`error` event) swaps itself for the initials circle.
- `messageNode`'s signature cache (§7.5 DOM rendering) includes the avatar filename, so a changed avatar re-renders.

### 15.5 Profile view (`#/me`)

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
- **E2E:** A uploads an avatar on `#/me`; B sees it next to A's next message. Axe check on `#/me`.

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
- **New message:** a **+** button in the DM section header opens a user search (`users.getList(1, 20, {filter:
  pb.filter("name ~ {:q} && id != {:me}", …), fields: "id,name,avatar"})`, debounced 200 ms, at least 1 character).
  Choosing a user calls `actions.openDm(userId)` → `POST /api/chat/dms` → `upsertRoom` → navigate to `#/r/:id`.
- **From a message:** clicking an author's name or avatar opens a small menu with **Message** (hidden for yourself),
  which does the same.
- **Room view:** unchanged apart from the header, the composer placeholder ("Message Bob") and the beginning marker
  ("Beginning of your conversation with Bob"). A DM shows the other member's avatar and name, and its menu has
  **Close conversation** (then back to `#/`) and **Jump to beginning**, never Archive. A closed DM opened by URL
  offers **Reopen conversation** instead.
- **Not a member:** opening `#/r/:id` of someone else's DM gets a 404 from `getRoom`, which already shows "room not
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

## 17. Attachments

### 17.1 Data model

`messages` gains one field:

| Field | Type | Notes |
|---|---|---|
| `files` | file, multiple | `maxSelect` 4, `maxSize` 8 MB each, **`protected: true`**, `thumbs`: `480x360` (center crop) and `240x180`. No `mimeTypes` allowlist: any file can be attached, because nothing is ever rendered from the file itself (§15 shared rules). |
| `file_names` | json | stored name → original upload name, written only by the create hook from the uploads themselves (bidi and invisible characters removed, 200 characters max); cleared by a soft delete, never changed by an edit (QA BUG-28) |

PocketBase's default request body limit (32 MB) fits 4 × 8 MB plus text; if the pinned version's default is lower, the
route gets `$apis.bodyLimit` for multipart message creates. A test pins this.

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

Tokens change the URL, so the browser cache can't reuse a thumbnail across token refreshes. This is accepted: each
thumbnail is ~20–40 KB and the window holds at most 300 messages.

### 17.4 Sending (optimistic, retry-safe)

The composer gains an **Attach** button ("+", opening a hidden `multiple` file input), drag-and-drop onto the room and paste
(`clipboardData.files`). Selected files show as a tray above the textarea: image thumbnails from object URLs,
other files as chips with name and size, each with a remove (×) button.

- Client checks before sending: at most 4 files, each ≤ 8 MB after preparation (§15.3, images re-encoded to at most
  2048 px). A rejected file shows why, inline, and is not added.
- Send works as in §7.5, with `FormData` instead of JSON: the client id, room, author, text and the files. The
  pending message shows the local previews dimmed, with a spinner (fetch has no upload progress; a progress bar would
  need XHR and is left out).
- **The pending entry keeps its `File` objects,** so **Retry** re-sends the same id with the same files. A duplicate
  id is still rejected by the server, so a retry after a lost response can never post twice.
- Once the server version replaces the pending one (§7.5 step 4), the object URLs are revoked.
- Leaving the room while an upload runs lets it finish (writes are not aborted, §6); a reload loses unsent files,
  like unsent text today.
- Archived rooms have no composer, so no attach button.

### 17.5 Rendering

- **Images** (by file extension: `jpg jpeg png gif webp avif`): a grid under the text. One image shows at 240×180;
  two to four show as a 2-column grid of 120×90 tiles. All use the `480x360` thumb with `object-fit: cover` and
  fixed `width`/`height`, so there is never a layout shift. Clicking opens the full file in a new tab
  (`target="_blank" rel="noopener"`), served under the sandbox CSP.
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
  4 × 8 MB.
- **Unit:** `displayName`; token cache (reuse, refresh after 2 min, one in-flight request); the composer tray (add,
  remove, limits, paste, drop); optimistic send with files, failure, and Retry with the same id and files; object
  URLs revoked on ack, removal and unmount; image grid layout classes for 1–4 images; expired-token retry happens
  once.
- **E2E:** A attaches an image and a PDF and sends; B sees the thumbnail and the file chip live and can open both;
  in a DM, C can't load the file URL even when given it; deleting the message removes the attachments for B; the
  XSS smoke test (§9.3) also uploads an `.html` file and checks that opening it runs no script.

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

- **`GET /api/chat/unread`** → `{ at, rooms: { "<roomId>": count } }` for the rooms with anything unread, where `at`
  is the server time the counts were taken (§18.3 uses it). One SQL query: for each room you can see (public, or a DM
  you are in), count the messages that are not yours, not deleted, and newer than `max(last_read_at, your signup)`,
  **stopping at 100** (the badge shows `99+`; without the cap a 50k backlog took ~200 ms per request). Each count is
  a correlated subquery, so it is a range scan on `idx_messages_room_created` (an integration test pins the query
  plan). Hidden and archived rooms are counted
  too; the client decides what to show (§18.4), and a room you unhide shows its real backlog.
- **`POST /api/chat/reads`** `{ room, at? }`: you have read `room` up to `at` (a message's `created`; default now).
  The position only moves forward and never past now; `at` must be a date (`""` is a 400, not "now"). A room you can't see (someone else's DM, no such room) is a
  404. Two tabs racing to create the row end up with one (the unique index, then an update). Rate limit: 120 per
  60 s per IP; the client sends at most about one per second per open room.

### 18.3 Client

- **One service, `unread.ts`,** started and stopped with the session next to `sync.ts` (`app.ts`). It owns the counts
  and everything about telling the server what was read. Views only read the store and report what they show.
- **State:** `AppState.unread` (room id → count). Loaded at login and on every reconnect; `refresh()` refetches,
  debounced. A failed count never affects the room list.
- **Live +1:** the service subscribes to **all** message events (`fields: id,room,author,created,deleted`, never the
  text), which the messages list rule already limits to rooms you can see. A create from someone else in a room
  other than the active one is +1. A soft delete in a room with unread messages refetches the counts (was the
  deleted message unread?). A count request in flight may or may not include a +1 that arrives meanwhile: the +1s
  received during it are kept with their message's `created`, and those newer than the answer's `at` are added on
  top. (Refetching instead starved the counts in a busy room: QA.) An answer older than the counts in the store is
  dropped.
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
- **No badge** for the active room, hidden rooms or archived rooms (`unreadCount()` in `store.ts`).
- Room rows are now flex rows: the name ellipsizes, and the `#`, the avatar and the badge always stay visible.

### 18.5 Tests

- **Integration:** counts (others' messages only; deleted, own and pre-signup ones excluded; DMs only for
  members); reads (clears up to `at`, default now, never back, never past now, one row under concurrent calls; 404
  for invisible rooms, 400 for bad and empty dates, 401 anonymous); `at`; the cap at 100; `room_reads` rules (private,
  no API writes, live only to its owner); the rate limit; the query plan.
- **Unit:** store updates and `unreadCount`; `unread.ts` (initial load, live +1 except own and active room, delete
  refetch, reads from another tab, failed counts, a +1 during a request, a room that never stops, debounced refresh;
  the reader: batching, close, flush, never as another user, retry, nothing after stop); room view (marks on open and
  live, flushes on leave, not from history, scrolled up or in a hidden tab, retries a failed read); app (logout sends a
  pending read); sidebar badges (count, `99+`, label, none where silent,
  live).
- **E2E:** Ada writes, Bob's badge counts live and survives a reload; opening the room clears it in Bob's other tab;
  new messages count again. Scrolled up, a new message stays unread until Bob scrolls down to it.
