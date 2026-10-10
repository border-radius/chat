# Next features — Implementation TODO (TDD)

> **Archived (2026-10-10):** every phase is done. Avatars, direct messages and attachments are specified in
> [`DESIGN.md`](../DESIGN.md) §15–§17.

Avatars, direct messages and attachments, as designed in [`DESIGN.md`](../DESIGN.md) §15–§17. Section references
like §16.3 point into the design doc.

## How to work through this list

Same loop as the MVP build plan ([`BUILD_PLAN.md`](BUILD_PLAN.md)):

1. **Red.** Write the tests named in the item and watch them fail for the expected reason.
2. **Green.** The smallest change that makes them pass.
3. **Refactor** while green. `npm run check` passes before every commit.
4. Tick the box and commit.

**Rules:**

- Phases ship in order and independently: **1 Avatars → 2 Direct messages → 3 Attachments.** Attachments come last
  because their access control depends on DM membership (§17.3).
- Every schema change is a **new migration** (`pb_migrations/17600000NN_*.js`) with a working `down`. Never edit the
  applied ones.
- Every limit the UI checks goes into `lib/limits.ts`, and `schema.test.ts` checks it against the migration.
- Code comments cite DESIGN sections (`§16.2`), never items in this file.
- Each phase ends with a **gate**: `npm run check` and `npm run test:e2e` green, `npm run build` within budget.

**Legend:** 🔴 = tests to write first, 🟢 = what to implement.

---

## Phase 0 — Shared groundwork

### 0.1 File-serving headers (§15 shared rules)
- [x] 🔴 `http.test.ts`: a file served from `/api/files/…` (upload a `.html` and an `.svg` to a throwaway test
      collection, or to `users.avatar` once 1.1 lands) has `Content-Security-Policy` containing `sandbox` and
      `X-Content-Type-Options: nosniff`
- [x] 🟢 Nothing needed: PocketBase sends the sandbox CSP itself (`files.http.test.ts`)
- [x] 🔴 `http.test.ts`: the app CSP's `img-src` is `'self' data: blob:`
- [x] 🟢 Add `blob:` to `CSP` in `pb_hooks/lib/chat.js`; update §5.6's CSP string

### 0.2 Image preparation (§15.3)
- [x] 🔴 `tests/unit/lib/image.test.ts`: `fitWithin(w, h, maxEdge)` scaling math (landscape, portrait, already
      small, square); `prepareImage` passes GIFs through unchanged, re-encodes JPEG/PNG/WebP (stubbed
      `createImageBitmap` / canvas), and returns the original file when decoding throws
- [x] 🟢 `web/src/lib/image.ts`: `fitWithin`, `prepareImage(file, maxEdge)` (OffscreenCanvas, `<canvas>` fallback,
      WebP then JPEG)

### 0.3 Multipart support in `api.ts`
- [x] 🔴 `tests/unit/api.test.ts`: a write with a `File` value is sent as `FormData` (the SDK does this when given
      `FormData`); `ApiError.fields` maps file-field validation errors (`maxSize`, `mimeTypes`) to messages
- [x] ~~🟢 A small `toFormData(fields)` helper~~: not needed. The SDK sends any body holding a `File` as multipart;
      covered by the `setAvatar` tests (also under happy-dom)

**Gate 0:** check green.

---

## Phase 1 — Avatars (§15)

### 1.1 Schema
- [x] 🔴 `schema.test.ts`: `users.avatar` has `maxSelect 1`, `maxSize 2 MB`, the MIME allowlist without SVG, thumbs
      `48x48` + `96x96`, `protected false`; `LIMITS.avatarBytes` matches
- [x] 🟢 Migration `…_avatars.js`: configure the existing field (down: restore PocketBase's defaults)

### 1.2 Rules and storage
- [x] 🔴 `users.test.ts`: A can set and remove their avatar; B cannot set A's; SVG and a 3 MB PNG are rejected; the
      `48x48` thumb URL returns `image/*`; after removal (or replacement) the old file URL returns 404
- [x] 🟢 Nothing beyond 1.1 expected; fix rules if a test says otherwise

### 1.3 API and types
- [x] 🔴 `api.test.ts`: `setAvatar(file)`, `removeAvatar()`, `rename(name)` return the updated `User`;
      `avatarUrl(user, 48)` is `""` without an avatar and a thumb URL with one; message pages include
      `expand.author.avatar` and still never `email`
- [x] 🟢 `User.avatar`; `MSG_FIELDS` + `expand.author.avatar`; `Api.setAvatar/removeAvatar/rename/avatarUrl`

### 1.4 Avatar component (§15.4)
- [x] 🔴 `tests/unit/lib/avatar.test.ts`: `initials()` (one word, two words, three words, emoji, combining marks,
      empty); `avatarColor(id)` stable per id, spread across the palette
- [x] 🔴 `tests/unit/ui/avatar.test.ts`: renders `<img alt="" width height loading="lazy">` with `srcset` when set,
      initials otherwise; an image `error` swaps in initials
- [x] 🟢 `web/src/lib/avatar.ts`, `web/src/ui/avatar.ts`; palette colors in `app.css` (light + dark, ≥ 4.5:1)

### 1.5 Message list and app bar
- [x] 🔴 `views/room.test.ts`: each author group header shows the avatar, continuation messages don't; a message
      whose author's avatar changed re-renders (signature includes it)
- [x] 🔴 `app.test.ts`: the app bar shows the own avatar and name, both link to `#/me`
- [x] 🟢 `views/room/messages.ts` group header; `app.ts` header

### 1.6 Profile view `#/me` (§15.5)
- [x] 🔴 `tests/unit/views/profile.test.ts`: shows current avatar and name; choosing a file previews immediately,
      uploads the prepared image, and updates the store user; failure restores the previous avatar and shows the
      error; Remove; rename saves and validates (`LIMITS.userName`); object URLs revoked on unmount
- [x] 🟢 `web/src/views/profile.ts`, route `#/me` in `app.ts`

### 1.7 E2E
- [x] 🔴 `tests/e2e/avatar.spec.ts`: A uploads an avatar on `#/me`; B sees it next to A's next message; A removes it
      and the initials come back after B reloads
- [x] 🔴 `a11y.spec.ts`: add `#/me`

**Gate 1:** check + e2e green; note the new bundle size in this file. ✅ JS 24.41 KB / 25, CSS 2.72 KB.

---

## Phase 2 — Direct messages (§16)

### 2.1 Schema
- [x] 🔴 `schema.test.ts`: `rooms.kind` (select `public|dm`, required), `members` (multi relation → users),
      `dm_key` (hidden) with a partial unique index, `last_message_at`; `name` no longer schema-required
- [x] 🔴 Migration test: existing rooms are backfilled to `kind = "public"`; down migration restores the MVP schema
- [x] 🟢 Migration `…_direct_messages.js`. Also made `idx_rooms_name` partial (`name != ''`): every DM's name is `""`

### 2.2 Rules (§16.3)
- [x] 🔴 `tests/integration/dms.rules.test.ts`:
  - C cannot list or view A–B's DM, or list, view or create messages in it
  - C's `"*"` subscriptions to `rooms` and `messages` receive nothing from the DM within 500 ms
  - `rooms.create` with `kind: "dm"` or `members` (also `members+`) is rejected; `dm_key` is a hidden field, which
    PocketBase silently ignores in non-superuser requests (the test checks the DB stays `""`)
  - `rooms.update` cannot change `kind`, `members`, `dm_key` or `last_message_at`; a DM cannot be archived or renamed
  - A and B can post, edit and soft-delete their own DM messages; B cannot edit A's
  - public rooms behave exactly as before (the existing suites stay green unchanged)
- [x] 🟢 New rules in the migration; hooks: members-only guard in `beforeMessageCreate` (defense in depth), reject
      `kind`/`members`/`dm_key` changes in `beforeRoomUpdate`; `name` required only for `public`, forced `""` for `dm`

### 2.3 `POST /api/chat/dms` (§16.2)
- [x] 🔴 `tests/integration/dms.route.test.ts`: first call creates (members, `dm_key`, `kind`), later calls by A or B
      return the same room; 10 concurrent calls produce one room; own id, unknown id, missing body → 400;
      anonymous → 401; unhides the caller's closed DM; the 11th call within 60 s → 429
- [x] 🟢 `routerAdd` in `pb_hooks/main.pb.js`, logic in `pb_hooks/lib/dms.js`; rate limit rule in the migration

### 2.4 Message hooks (§16.4)
- [x] 🔴 A message in a DM sets the room's `last_message_at` and deletes the **recipient's** `hidden_rooms` row
      (not the sender's); B's `hidden_rooms` subscription receives the delete; a public-room message changes neither
- [x] 🔴 `pagination.test.ts`: `EXPLAIN QUERY PLAN` with the new list rule still uses `idx_messages_room_created`
      (the rule's join written out by hand, shaped like PocketBase's generated SQL)
- [x] 🟢 `onRecordAfterCreateSuccess` for `messages`

### 2.5 API, types, store
- [x] 🔴 `api.test.ts`: `openDm(userId)` returns the room; `listRooms` returns public rooms + own DMs with
      `expand.members` (id, name, avatar; no email); `searchUsers(q)` excludes self, caps at 20, binds `q` safely
- [x] 🔴 `tests/unit/lib/rooms.test.ts`: `roomTitle(room, me)` for public rooms and DMs (including a member whose
      expand is missing → "Unknown")
- [x] 🔴 `store.test.ts`: `roomSections` returns `dms` sorted by `last_message_at` then `created` desc; closed DMs
      are omitted; a DM never lands in Hidden or Archived
- [x] 🔴 A realtime DM `update` (new `last_message_at`) reorders the section (tested end to end in `views/rooms.test.ts`)
- [x] 🟢 `Room` type, `ROOM_FIELDS`, `Api.openDm/searchUsers`, `lib/rooms.ts`, `roomSections`, `actions.openDm`

### 2.6 Sidebar and room UI (§16.5)
- [x] 🔴 `views/rooms.test.ts`: the Direct messages section renders titles and avatars; **+** opens the user search
      (debounced, empty state, keyboard navigation); choosing a user calls `openDm` and navigates
- [x] 🔴 `views/room.test.ts`: a DM header shows the other member's avatar and name; its menu has Close conversation
      and Jump to beginning but no Archive; Close hides it and navigates to `#/`
- [x] 🔴 Author menu: clicking another author's name offers **Message**, which opens the DM; not shown for yourself
- [x] 🟢 `views/rooms.ts`, `ui/user-search.ts`, `views/room/header.ts`, `views/room/messages.ts`

### 2.7 E2E
- [x] 🔴 `tests/e2e/dm.spec.ts`: A opens a DM with B via search and sends; B sees it appear live and replies; C's
      sidebar never shows it and C's visit to its URL shows "room not found"; B closes it, A writes again, it
      reappears for B
- [x] 🔴 `a11y.spec.ts`: the user search open; a DM room

**Gate 2:** check + e2e green; bundle size noted. ✅ JS 25.86 KB (budget raised to 30 KB, DESIGN §13), CSS 2.90 KB.

---

## Phase 3 — Attachments (§17)

### 3.1 Schema and limits
- [x] 🔴 `schema.test.ts`: `messages.files` (`maxSelect 4`, `maxSize 8 MB`, `protected true`, thumbs `480x360`,
      `240x180`); `LIMITS.attachments` / `LIMITS.attachmentBytes` match
- [x] 🔴 `http.test.ts`: a multipart create with 4 × 8 MB files is accepted (body limit fits)
- [x] 🟢 Migration `…_attachments.js`. No `$apis.bodyLimit` needed: PocketBase sizes the records API body limit
      from the collection's file fields

### 3.2 Rules and hooks (§17.1)
- [x] 🔴 `tests/integration/messages.files.test.ts`:
  - files-only message accepted; no text and no files rejected; whitespace text + a file accepted with text `""`
  - a 5th file and an over-size file rejected
  - an edit cannot set `files`, `files+` or `files-`; the text edit still works and keeps the files
  - soft delete empties `files`, and the old file URL returns 404
  - archived room: create with files rejected (existing guard)
- [x] 🟢 Update rule `@request.body.files:isset = false`; hooks: text-or-files check, reject file changes on
      update, wipe `files` on soft delete

### 3.3 Protected access (§17.3)
- [x] 🔴 File URL without a token → 403/404; with A's token → 200; C's token on an A–B DM file → 404; an `.html` and
      an `.svg` attachment are served with the sandbox CSP and `nosniff`
- [x] 🔴 `api.test.ts`: `fileUrl()` reuses a cached token, refreshes it after 2 min (fake timers), shares one
      in-flight token request; `MSG_FIELDS` includes `files`
- [x] 🟢 Token cache and `fileUrl(message, filename, thumb?)` in `api.ts`

### 3.4 Pure helpers
- [x] 🔴 `tests/unit/lib/files.test.ts`: `displayName()` strips PocketBase's `_xxxxxxxxxx` suffix (and leaves names
      without one alone); `isImage()` by extension; `formatBytes()`; `checkFiles(existing, added)` enforces count and
      size and returns per-file reasons
- [x] 🟢 `web/src/lib/files.ts`

### 3.5 Composer (§17.4)
- [x] 🔴 `views/room/composer.test.ts`: Attach button, paste and drop add files to the tray (images previewed,
      others as chips); × removes and revokes the object URL; over-limit files are refused with a reason; Send is
      enabled with files and no text; Enter sends; the tray clears on send
- [x] 🟢 `views/room/composer.ts`, `ui/file-tray.ts`

### 3.6 Optimistic send with files
- [x] 🔴 `views/room.test.ts`: the pending message shows local previews and a spinner; ack replaces it and revokes
      the object URLs; failure shows Retry, and Retry sends the **same id and files**; a retry after a lost
      response does not duplicate; removing a failed send revokes its URLs; unmount revokes all
- [x] 🟢 `Message.localFiles` (client-only, like `status`); `api.send` passes `files` (the SDK sends multipart)

### 3.7 Rendering (§17.5)
- [x] 🔴 `views/room.test.ts`: 1 image → single 240×180 box; 2–4 → grid tiles; every `<img>` has `width`, `height`,
      `loading="lazy"`; non-images render as download chips with the display name; deleted messages show no
      attachments; edit mode keeps attachments visible without remove buttons; a realtime message with files from
      another user renders; an image `error` gets one fresh-token retry, then a "Couldn't load image" box with Retry
- [x] 🔴 Scroll anchoring: image tiles keep their size before and after loading (checked in the browser,
      `attachments.spec.ts`; happy-dom has no layout)
- [x] 🟢 `views/room/messages.ts` (+ signature includes `files`), CSS for the grid and chips

### 3.8 E2E
- [x] 🔴 `tests/e2e/attachments.spec.ts`: A sends an image + a PDF; B sees the thumbnail and chip live and opens
      both; in a DM, C gets no file even with the URL; deleting the message removes the attachments for B
- [x] 🔴 XSS (in `attachments.spec.ts`): an uploaded `.html` attachment is served as a download with a sandbox CSP,
      and opening its URL runs no script
- [x] 🔴 `mobile.spec.ts`: attach and send at 390×844
- [x] 🔴 `a11y.spec.ts`: a room with attachments and a filled tray

**Gate 3:** check + e2e green on all three browsers. ✅ Chromium locally (JS 27.81 KB / 30, CSS 3.24 KB); Firefox and
WebKit aren't installed in this dev container, so they first run in CI.

---

## Phase 4 — Wrap-up

- [x] Bundle budget decision (§13 still open #1): raised to 30 KB, one bundle (DESIGN §7.7, §13)
- [x] README: feature list, rate limits (`POST /api/chat/dms`), storage note
- [x] DESIGN.md: move the resolved open questions into "Decided"; refresh §4 layout with the new modules
- [x] Archive this file to `docs/history/` once every box is ticked
