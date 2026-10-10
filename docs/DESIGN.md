# Chat — MVP Design Document

| | |
|---|---|
| **Status** | Draft |
| **Date** | 2026-10-10 |
| **Scope** | MVP |

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

- Private rooms, room membership or invitations, direct messages
- File and image uploads, link previews
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
├── docs/DESIGN.md
├── package.json
├── tsconfig.json
├── scripts/
│   ├── fetch-pocketbase.sh     # downloads the pinned PB release into ./bin
│   ├── build.mjs               # esbuild production build → pb_public/
│   └── dev.mjs                 # esbuild watch + spawns `pocketbase serve`
├── pb_migrations/              # schema + API rules (committed)
│   └── 1760000000_init.js
├── pb_hooks/                   # server-side JS hooks (committed)
│   └── main.pb.js
├── web/
│   ├── index.html              # template; build injects hashed asset names
│   ├── styles/app.css
│   └── src/
│       ├── main.ts             # boot: auth restore, router start
│       ├── api.ts              # the only module that imports the PB SDK
│       ├── store.ts            # tiny observable state
│       ├── router.ts           # hash router
│       ├── dom.ts              # h(), clear(), on() helpers
│       ├── lib/
│       │   ├── id.ts           # client-side PB-compatible record ids
│       │   ├── time.ts         # cached Intl formatters, relative time
│       │   └── messages.ts     # pure list logic: merge, dedupe, group
│       └── views/
│           ├── login.ts
│           ├── rooms.ts
│           └── room.ts         # message list + composer
├── tests/
│   ├── unit/                   # Vitest + happy-dom
│   ├── integration/            # Vitest against a real PocketBase process
│   └── e2e/                    # Playwright
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

The source of truth for all rules is `pb_migrations/1760000000_init.js`.

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
- **Security headers** via `routerUse`: every response gets `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. Static app paths also get `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The CSP is *not* applied to `/api/*` or to the admin UI `/_/`, which sends its own CSP.
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
| `#/` | room list + "new room" form | |
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

**DOM rendering (`views/room.ts`):**

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
| `app.js` (including the PB SDK) | **≤ 25 KB** |
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

### Still open

None for the MVP.

## 14. Future work (post-MVP)

Private rooms and membership (a `room_members` collection plus rule changes), DMs, uploads (PB file fields with thumbs), reactions, typing and presence (custom realtime channels via `$app.subscriptionsBroker()`), OAuth2 providers, message search (SQLite FTS5 through a custom route), a service worker for an offline shell, and HttpOnly cookie auth.
