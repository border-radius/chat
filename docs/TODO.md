# Chat MVP — Implementation TODO (TDD)

This plan implements [`DESIGN.md`](./DESIGN.md) using test-driven development. Section references like §7.5 point into the design doc.

## How to work through this list

Every feature item follows the same loop:

1. **Red.** Write the test or tests named in the item. Run them and confirm they **fail for the expected reason**, not because of a typo or a missing import.
2. **Green.** Write the *smallest* amount of code that makes them pass.
3. **Refactor.** Clean up while staying green. Run `npm run typecheck` too.
4. Tick the box and commit (`test:` + `feat:`, or a single commit for a small item).

**Rules:**

- **No production code without a failing test first.** The exceptions are tooling and config in Phase 0, plain CSS, and the HTML template. Those are verified by running them.
- **Bottom-up order:** schema and rules → pure logic → DOM helpers → views → end to end. Each layer is built on a layer that is already tested.
- **Fast loop:** keep `npx vitest --project unit` running in watch mode during frontend work. Integration tests run on demand.
- **Every bug found later gets a failing test first,** reproducing it, before the fix.
- Each phase ends with a **gate**. Don't start the next phase until the gate passes.

**Legend:** 🔴 = the test or tests to write first, 🟢 = what to implement to make them pass.

---

## Phase 0 — Tooling and test harness (M1)

The goal of this phase is to make every test layer runnable, starting with the build, before any feature code exists.

### 0.1 Repo setup
- [ ] `git init`, `.gitignore` (`node_modules/ bin/ pb_public/ pb_data/ test-results/ playwright-report/`)
- [ ] `package.json` (`"type": "module"`), with dependencies from §8.1 only: `pocketbase`, plus dev dependencies `esbuild typescript vitest happy-dom @playwright/test @axe-core/playwright`
- [ ] `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `target es2022`, `moduleResolution bundler`, `noEmit`, `lib: [es2022, dom, dom.iterable]`
- [ ] Directory layout from §4 (empty files are fine)

### 0.2 PocketBase binary
- [ ] `scripts/fetch-pocketbase.sh`: pin `PB_VERSION`, detect OS and architecture, download into `bin/`, verify SHA-256, and do nothing if the right version is already present
- [ ] `npm run setup` works. `bin/pocketbase --version` prints the pinned version.

### 0.3 Test runner: Vitest projects
- [ ] `vitest.config.ts` with two projects:
  - `unit`: `tests/unit/**`, `environment: happy-dom`
  - `integration`: `tests/integration/**`, `environment: node`, `globalSetup`, `fileParallelism: false`, longer timeout
- [ ] 🔴 `tests/unit/smoke.test.ts`: `expect(1).toBe(1)`, then 🟢 `npm test` runs it
- [ ] `npm test` = `vitest run --project unit` and `npm run test:int` = `vitest run --project integration`

### 0.4 Integration harness (§9.2)
- [ ] 🔴 `tests/integration/health.test.ts`: `GET /api/health` returns 200
- [ ] 🟢 `tests/integration/setup/pocketbase.ts`:
  - make a temp dir and pick a free port;
  - run `superuser upsert`;
  - run `serve --dir --migrationsDir pb_migrations --hooksDir pb_hooks`;
  - wait for `/api/health`;
  - `provide("pbUrl")`;
  - kill the process and remove the dir on teardown.
- [ ] 🟢 `tests/integration/helpers.ts`: `adminClient()`, `newUser(name?)` (returns an authed SDK client and record), `newRoom(client, name?)`, `post(client, room, text)`
- [ ] Export the spawn helper so Playwright can reuse it (Phase 7)

### 0.5 Build script (§8.2)
- [ ] 🔴 `tests/unit/build/budget.test.ts`: `checkBudget({js, css, html})` (a pure function taking gzipped sizes) passes when under the limits and returns the names of any assets over them (§7.7)
- [ ] 🔴 `tests/unit/build/html.test.ts`: `injectAssets(template, {js, css})` replaces placeholders with hashed paths and fails if a placeholder is missing
- [ ] 🟢 `scripts/lib/build-utils.mjs` with `checkBudget` and `injectAssets`
- [ ] 🟢 `scripts/build.mjs`:
  - esbuild with hashed `entryNames` writing to `pb_public/assets/`;
  - read the metafile, inject asset names, write `pb_public/index.html`;
  - print gzipped sizes and exit 1 if over budget.
- [ ] `web/index.html` template with a static app shell and `<!--CSS-->` / `<!--JS-->` placeholders
- [ ] `web/src/main.ts` renders "hello" into `#app`

### 0.6 Dev script
- [ ] `scripts/dev.mjs`: esbuild `context().watch()` (unminified, inline sourcemaps, unhashed names) writing to `pb_public/`, plus a child process running `bin/pocketbase serve --dev`, both stopped by one Ctrl-C
- [ ] Manual check: `npm run dev`, open `http://127.0.0.1:8090`, and "hello" renders

### 0.7 E2E harness
- [ ] `playwright.config.ts`: `webServer` runs `npm run build`, then the spawn helper with a temp DB. Chromium locally and all three browsers in CI. Traces are kept on failure.
- [ ] 🔴 `tests/e2e/smoke.spec.ts`: page loads, "hello" is visible, there are no console errors, then 🟢 make it pass

### 0.8 Static checks and CI
- [ ] `scripts/check-no-html-sinks.sh`: grep `web/src` for `innerHTML|outerHTML|insertAdjacentHTML|document.write` and exit 1 if any match (§9.5)
- [ ] 🔴 Prove the check works: temporarily add `el.innerHTML = ""`, confirm the script fails, then remove it
- [ ] npm scripts: `typecheck`, `lint:sinks`, `check` (typecheck + lint:sinks + test + test:int + build), `test:e2e`
- [ ] `.github/workflows/ci.yml` (§9.6). The PocketBase binary is cached by version, and Playwright traces are uploaded when a test fails.

**✅ Gate 0:** `npm run check && npm run test:e2e` are green locally and in CI.

---

## Phase 1 — Schema, rules and hooks (M2)

Phase 1 is backend-only and fully covered by integration tests. Each test file uses fresh users, so tests never share data.

### 1.1 Collections and indexes (§5.1–5.4)
- [ ] 🔴 `schema.test.ts`: as admin, fetch collections and assert:
  - `users.name` is required, 1–32 chars;
  - `rooms` fields: `name`, `created_by`, `archived`, `archived_at`, plus the unique case-insensitive index on name;
  - `messages` fields: `room`, `author`, `text` (max 2000, not required), `edited_at`, `deleted`, `deleted_at`, plus the `(room, created, id)` index;
  - `hidden_rooms` fields: `user`, `room`, plus a unique `(user, room)` index;
  - the expected cascade settings.
- [ ] 🟢 `pb_migrations/<ts>_init.js`: create the collections, fields and indexes (empty rules for now, so superuser only)
- [ ] 🔴 Migrations are idempotent: restart the server on the same data dir and it boots cleanly with the schema unchanged
- [ ] 🟢 Fix any problems

### 1.2 `users` rules
- [ ] 🔴 `users.test.ts`:
  - anonymous signup works and the user can log in **without verification**;
  - an authed user listing other users never gets their `email`;
  - A can update their own `name` but not B's;
  - an anonymous user cannot list users.
- [ ] 🟢 Set the `users` rules in the migration and set `emailVisibility` to false by default

### 1.3 `rooms` rules
- [ ] 🔴 `rooms.test.ts`:
  - **Create:**
    - an authed user can create a room with `created_by = self`;
    - `created_by = other` is rejected;
    - creating with `archived: true` is rejected;
    - an anonymous user cannot create a room.
  - **Unique names:**
    - a duplicate name is rejected;
    - a name that differs only in case is rejected.
  - **List and view:** any authed user can list and view rooms; an anonymous user cannot.
  - **Update:**
    - the creator can rename the room;
    - another user cannot rename it;
    - nobody can change `created_by`;
    - nobody can set `archived_at` directly.
  - **Delete:** the `DELETE` endpoint is rejected for the creator and for other users.
- [ ] 🟢 Set the `rooms` rules (§5.5)

### 1.4 Room archiving
- [ ] 🔴 `rooms.archive.test.ts`:
  - the creator setting `archived: true` sets `archived_at`;
  - setting `archived: false` clears it;
  - a user who is not the creator cannot archive or unarchive;
  - an archived room's name can't be taken by a new room or by a rename (it is never reused);
  - an archived room is still listed and viewable.
- [ ] 🟢 Archive stamp hook in `pb_hooks/main.pb.js`

### 1.5 `messages` create rules and validation
- [ ] 🔴 `messages.create.test.ts`:
  - **Author:**
    - A can post with `author = A`;
    - `author = B` is rejected;
    - an anonymous user cannot post.
  - **Text:**
    - text is trimmed;
    - whitespace-only text is rejected;
    - 2001 chars is rejected;
    - 2000 chars is accepted.
  - **Ids:**
    - a client-supplied 15-char id is accepted;
    - reusing an existing id is rejected.
  - **Not deletable on create:** creating with `deleted: true` is rejected.
  - **Archived rooms:** posting to an archived room is rejected. Unarchiving makes posting work again.
- [ ] 🟢 Set the `messages` create rule, plus hooks for trim and non-empty text and the archived-room guard (§5.6)

### 1.6 `messages` editing
- [ ] 🔴 `messages.edit.test.ts`:
  - A edits their own message → the text changes and `edited_at` is set;
  - an update with the same text leaves `edited_at` empty;
  - B cannot edit A's message;
  - changing `author` or `room`, or setting `edited_at` directly, is rejected;
  - editing to whitespace-only text or more than 2000 chars is rejected;
  - editing in an archived room is rejected.
- [ ] 🟢 Set the update rule and the edit stamp hook

### 1.7 `messages` soft delete
- [ ] 🔴 `messages.delete.test.ts`:
  - **The delete itself:**
    - `update({deleted: true})` returns `deleted = true`, `text = ""` and `deleted_at` set;
    - `{deleted: true, text: "x"}` still results in empty text;
    - the raw DB row (admin client) has empty text;
    - `edited_at` is unchanged.
  - **After deleting:**
    - the message still appears in list results;
    - a deleted message rejects edits;
    - `{deleted: false}` is rejected.
  - **Permissions:**
    - B cannot delete A's message;
    - setting `deleted_at` directly is rejected;
    - the `DELETE` endpoint is rejected for the author;
    - deleting in an archived room is rejected.
- [ ] 🟢 Soft delete hook and update rule details

### 1.8 `hidden_rooms` rules
- [ ] 🔴 `hidden_rooms.test.ts`:
  - **Hiding:**
    - A can hide a room for themselves;
    - `user = B` is rejected;
    - a duplicate hide is rejected.
  - **Listing:**
    - B's list never contains A's rows;
    - an anonymous user's list is empty or denied.
  - **Unhiding:**
    - A can delete their own row;
    - B cannot delete A's row.
  - **Updates:** updating a row is rejected for everyone.
- [ ] 🟢 Set the `hidden_rooms` rules

### 1.9 Realtime
- [ ] 🔴 `realtime.test.ts` (SDK in Node with an `EventSource` polyfill or the SDK's built-in support):
  - B is subscribed to R1 with a filter and `expand=author`:
    - when A posts in R1, B gets a `create` event with `expand.author.name` and no email;
    - when A posts in R2, nothing arrives within 500 ms.
  - **Edits and deletes:**
    - an edit arrives as an `update` event;
    - a soft delete arrives as an `update` event with `deleted: true` and `text: ""`.
  - **Anonymous:** an anonymous subscriber receives nothing.
  - **Hidden rooms:** a `hidden_rooms` subscription only delivers your own rows.
- [ ] 🟢 This is expected to pass from the rules alone. Fix the rules if it doesn't.

### 1.10 History pagination at scale
- [ ] 🔴 `pagination.test.ts`:
  - **Seed data:** 1,000 messages through the admin client, including about 20 that share the same `created` value.
  - **Older-page walk:** walking from the latest page returns all 1,000 messages once each, in order, with message #1 last.
  - **Newer-page walk:** walking from the first page gives the same result.
  - **Index use:** `EXPLAIN QUERY PLAN` for the cursor query uses `idx_messages_room_created`.
- [ ] 🟢 Put the cursor filter builder in **shared code** (`web/src/lib/cursor.ts`) and import it from the test. The frontend reuses the exact same function, so the cursor logic is tested once against the real DB.

### 1.11 Headers and rate limits
- [ ] 🔴 `http.test.ts`:
  - `GET /` has the CSP, `nosniff` and `Referrer-Policy` headers;
  - `/assets/*` has `immutable` caching;
  - `/` and `/index.html` have `no-cache`;
  - the 11th message within 5 seconds returns 429.
- [ ] 🟢 `routerUse` middleware in hooks. Rate-limit settings applied from a migration.

**✅ Gate 1:** `npm run test:int` is green, and the backend is feature-complete for the MVP. The rules are frozen. Later changes need a red test first.

---

## Phase 2 — Pure frontend logic (M3, part 1)

Everything in this phase is pure TypeScript with no DOM and no network, so the tests are the fastest in the project.

### 2.1 `lib/id.ts`
- [ ] 🔴 Ids are 15 chars and match `/^[a-z0-9]{15}$/`. 10,000 ids have no collisions. The function uses `crypto.getRandomValues` (spy on it).
- [ ] 🟢 `newId()`

### 2.2 `lib/time.ts`
- [ ] 🔴 With `TZ=UTC` and a fixed `now`:
  - a time today shows as the time only;
  - other days show the date and time;
  - the date divider label is correct;
  - formatters are created once (spy on `Intl.DateTimeFormat`).
- [ ] 🟢 Formatting helpers

### 2.3 `lib/cursor.ts` (already partly done in 1.10)
- [ ] 🔴 Unit tests: the `older(room, msg)`, `newer(room, msg)`, `latest(room)` and `first(room)` query builders give the correct filter, sort, `skipTotal` and fields. Values are passed as `pb.filter` params and never concatenated into the string.
- [ ] 🟢 Fill in the remaining builders

### 2.4 `lib/messages.ts`: window model (§7.5)
- [ ] 🔴 `merge`:
  - sorts by `(created, id)`, including for messages with the same `created` value;
  - dedupes by id;
  - a server version replaces a `pending` one;
  - the version with the later `updated` wins (edits and deletes);
  - merging an empty page is a no-op.
- [ ] 🔴 `remove`: removes by id; an unknown id is a no-op
- [ ] 🔴 `trim("bottom", 300)`: on 350 items, drops the newest 50 and sets `hasNewer`. `trim("top")` mirrors this and sets `hasOlder`. The function returns the dropped ids.
- [ ] 🔴 `applyPage(win, page, dir)`: a short older page sets `hasOlder = false` and a short newer page sets `hasNewer = false`
- [ ] 🔴 `group`:
  - splits on author change;
  - splits on a gap over 5:00 but not at exactly 5:00;
  - deleted placeholders take part in grouping.
- [ ] 🔴 `lastOwnEditable(win, me)`: skips deleted, pending and failed messages, and messages from others
- [ ] 🟢 Implement all of the above

### 2.5 `store.ts`
- [ ] 🔴 The emitter notifies subscribers on change, and unsubscribing stops notifications
- [ ] 🔴 `roomSections(state)`:
  - Rooms and Hidden are sorted by name;
  - an archived room goes to Archived even when it is also hidden;
  - hidden rooms produce no unread count or badge data (a silent hide).
- [ ] 🟢 Store and selectors

**✅ Gate 2:** unit tests are green, and `lib/` and `store.ts` have ≥ 95% line coverage (`vitest --coverage`, informational).

---

## Phase 3 — DOM foundation, router, api seam, auth (M3, part 2)

### 3.1 `dom.ts`
- [ ] 🔴 `h()` sets the class, attributes, `dataset` and event listeners, and handles nested children
- [ ] 🔴 **XSS:** a string child `<img src=x onerror=…>` becomes a text node, and `querySelector("img")` returns null
- [ ] 🔴 `clear(el)` removes all children. Listeners added with `{signal}` stop after `abort()`.
- [ ] 🟢 `h`, `clear` and `on`

### 3.2 `api.ts`: the seam
- [ ] Define an `Api` TypeScript interface covering every call in §6. Views depend only on this interface.
- [ ] 🟢 `createApi(pb)` is the real implementation, a thin wrapper around the SDK (it's already exercised by integration tests through the shared cursor builder).
- [ ] 🟢 `tests/unit/fakes/fake-api.ts`: an in-memory `Api` with controllable latency and failures, plus `emit(event)` to simulate realtime events
- [ ] 🔴 Fake api contract tests: the same small suite (create, list by cursor, update, soft delete) runs against the fake api and, in the integration project, against the real `createApi`, so the fake can't drift from real behavior

### 3.3 `router.ts`
- [ ] 🔴 It matches `#/`, `#/login`, `#/r/:id` and `#/r/:id/m/:msgId`, and extracts params
- [ ] 🔴 An unknown hash redirects to `#/`, and an unauthenticated user is redirected to `#/login`
- [ ] 🔴 On navigation, `unmount()` of the previous view is called before the next view's `mount()`
- [ ] 🟢 Router

### 3.4 Login view (`views/login.ts`)
- [ ] 🔴 It has Login and Signup tabs and the right fields per tab. Submitting calls the fake api.
- [ ] 🔴 Server validation errors appear inline. Success navigates to `#/`. The button is disabled while a request is in flight.
- [ ] 🟢 Login view

### 3.5 Boot (`main.ts`)
- [ ] 🔴 With a valid stored token, the app goes straight to the route and calls `authRefresh` in the background. With no token it goes to `#/login`. Logout clears auth, unsubscribes everything and goes to `#/login`.
- [ ] 🟢 `main.ts` wiring

**✅ Gate 3:** unit tests are green. `npm run dev` lets you sign up and log in manually.

---

## Phase 4 — Rooms list (M4)

### 4.1 Rendering and creation
- [ ] 🔴 `views/rooms.test.ts`:
  - **Sections:** Rooms, Hidden (collapsed, with a count) and Archived (collapsed) are rendered from the fake api.
  - **New room form:**
    - creating a room calls `rooms.create` and the room appears;
    - a duplicate-name error from the server appears inline.
- [ ] 🟢 Rooms view and the sidebar layout

### 4.2 Hide and unhide
- [ ] 🔴 Hide calls `hidden_rooms.create` and moves the room to Hidden. Unhide calls `delete` with the row id and moves it back.
- [ ] 🔴 A realtime `hidden_rooms` event from another tab updates the sections
- [ ] 🔴 New messages in a hidden room cause **no** UI change in the list
- [ ] 🟢 Implement

### 4.3 Archive and unarchive
- [ ] 🔴 The Archive action is visible only to the creator. It shows an inline confirm, and only Confirm calls `rooms.update({archived: true})`.
- [ ] 🔴 A realtime room `update` with `archived: true` moves the room to Archived. Unarchive moves it back.
- [ ] 🟢 Implement

### 4.4 Realtime room list
- [ ] 🔴 A room created elsewhere appears, and a rename updates its label. `unmount` unsubscribes.
- [ ] 🟢 Implement

**✅ Gate 4:** unit tests are green. Manual smoke test of the room list in two browsers.

---

## Phase 5 — Room view (M5)

This is the hot path. All tests use the fake api, seeded as needed.

### 5.1 Initial load and rendering
- [ ] 🔴 Opening a room renders the latest 50 messages, oldest at the top, with author grouping and date dividers. The view is scrolled to the bottom.
- [ ] 🔴 The SSE subscribe and the latest-page fetch start in parallel. `unmount` unsubscribes, aborts requests and leaves no listeners.
- [ ] 🟢 Room view skeleton, the message element renderer, and the `Map<id, el>` index

### 5.2 Composer and optimistic send (§7.5, §7.6)
- [ ] 🔴 **Keys:** Enter sends and Shift+Enter adds a newline.
- [ ] 🔴 **Blocking:** empty, whitespace-only or over-2000-char text is blocked, and a counter appears above 1800 chars.
- [ ] 🔴 **Optimistic send:**
  - the message appears straight away as `pending`;
  - the server ack clears the pending state;
  - the realtime echo with the same id does not duplicate it.
- [ ] 🔴 **Failure:**
  - the message is marked failed and shows Retry;
  - Retry calls `create` again with the **same id**;
  - the composer text is kept.
- [ ] 🟢 Implement

### 5.3 Live updates and scroll behavior
- [ ] 🔴 At the live edge and near the bottom, a realtime `create` appends the message and auto-scrolls.
- [ ] 🔴 When scrolled up, it shows the "↓ New messages" pill and does not scroll.
- [ ] 🟢 Implement

### 5.4 Windowed history (§7.5)
- [ ] 🔴 **Scrolling up to the beginning** (fake api with 1,000 messages):
  - repeatedly triggering the top sentinel reaches message #1;
  - "Beginning of #room" appears and the top sentinel goes away;
  - the DOM never holds more than 300 messages;
  - no message is duplicated or skipped.
- [ ] 🔴 **Scrolling back down:** the bottom sentinel loads newer pages until `hasNewer = false`.
- [ ] 🔴 **Scroll anchoring:** prepending and trimming keep the anchor element's on-screen position. Stub layout in happy-dom with a fixed row height and assert the `scrollTop` math.
- [ ] 🔴 **Away from the live edge** (`hasNewer`): a realtime `create` is not appended and the "Jump to latest" pill appears. Clicking it resets to the latest page.
- [ ] 🔴 **Jumping:** "Jump to beginning" loads the first page. `#/r/:id/m/:msgId` opens a window centered on that message.
- [ ] 🔴 **Concurrency:**
  - only one fetch runs per direction at a time;
  - a page that arrives after a jump is discarded (generation counter).
- [ ] 🟢 Implement using `IntersectionObserver` (mocked in tests)

### 5.5 Reconnect gap fill
- [ ] 🔴 **At the live edge:** a simulated `PB_CONNECT` after a disconnect fetches newer pages in a loop until a short page comes back, then merges them. 80 missed messages all appear in order.
- [ ] 🔴 **Scrolled into history:** no fetch happens.
- [ ] 🔴 **Room record:** the room is refetched on reconnect, and if it was archived the view switches to read-only.
- [ ] 🟢 Implement

### 5.6 Editing (§7.6.1)
- [ ] 🔴 **Opening and saving:**
  - Edit shows a prefilled textarea;
  - Enter calls `update`, and "(edited)" appears after the server responds;
  - Esc restores the text with no request;
  - unchanged text makes no request.
- [ ] 🔴 **Failure:** a failed save restores the old text and shows an inline error with Retry.
- [ ] 🔴 **Up arrow:** in an empty composer it edits the last of the user's own messages, skipping deleted ones.
- [ ] 🔴 **Other users:**
  - there are no Edit or Delete actions on others' messages;
  - a realtime edit from someone else updates the message in place.
- [ ] 🟢 Implement

### 5.7 Soft delete (§7.6.2)
- [ ] 🔴 **Delete flow:**
  - Delete shows an inline confirm;
  - Confirm calls `update({deleted: true})`;
  - the message becomes a placeholder with the author, the time and "Message deleted";
  - Cancel makes no request.
- [ ] 🔴 **Failure:** the original text is restored.
- [ ] 🔴 **Realtime:** a soft delete from another user swaps in the placeholder.
- [ ] 🔴 **Placeholder rules:**
  - placeholders have no actions and no "(edited)" label;
  - deleting a pending or failed send removes it with no request.
- [ ] 🔴 **Hard delete:** a realtime `delete` event (superuser) removes the element.
- [ ] 🟢 Implement

### 5.8 Archived room mode
- [ ] 🔴 An archived room shows the banner. There is no composer and there are no Edit or Delete actions, and history is still scrollable. A live archive event switches an open room to read-only straight away, and unarchiving brings the composer back.
- [ ] 🟢 Implement

**✅ Gate 5:** unit tests are green, and you can chat end to end by hand in two browsers.

---

## Phase 6 — Polish (M6)

CSS has no unit tests, so it is verified by e2e and accessibility checks (Phase 7) and by the size budget.

- [ ] `web/styles/app.css`:
  - custom properties for colors and spacing;
  - light and dark themes via `prefers-color-scheme`;
  - system font stack;
  - mobile-first layout with the sidebar collapsing below 720 px;
  - `white-space: pre-wrap` for message text;
  - visible focus rings;
  - muted italic style for placeholders.
- [ ] Accessibility markup:
  - semantic landmarks;
  - messages in an `<ol>`;
  - `aria-live="polite"` on the message list;
  - labelled buttons and inputs;
  - inline confirms reachable by keyboard.
- [ ] 🔴 Unit: every action is reachable by keyboard (Tab order through the message actions, with Enter and Esc in confirms)
- [ ] Static app shell in `index.html` (title bar plus a skeleton) so something paints before JS runs
- [ ] `npm run build` stays within budget (JS ≤ 25 KB, CSS ≤ 5 KB gzipped). If it doesn't, cut code rather than raise the budget.

**✅ Gate 6:** build within budget, plus manual review in light and dark themes and at 390 px wide.

---

## Phase 7 — End to end, accessibility, release (M7)

Each flow from §9.3 starts as a failing spec. Fix the app, not the test, unless the test itself is wrong.

- [ ] 🔴 `signup.spec.ts`: sign up, see the empty list, create "general", send "hello", and see it with the user's name
- [ ] 🔴 `realtime.spec.ts`:
  - with two contexts, B sees A's message within 1 second;
  - when B deletes a message, A sees the placeholder;
  - after a reload the placeholder is still there.
- [ ] 🔴 `history.spec.ts`:
  - **Setup:** seed 2,000 messages.
  - **Scroll up:** message #1 is reachable by scrolling, the DOM stays at or below 300 messages, and the view doesn't jump.
  - **Live edge:** scrolling back down reaches the live edge, and a message B sends then appears live.
  - **Jump:** "Jump to beginning" works.
- [ ] 🔴 `edit.spec.ts`: B sees A's edit live with "(edited)". The Up-arrow shortcut works.
- [ ] 🔴 `hide.spec.ts`: A hides a room and B is unaffected. The room still opens by URL, and Unhide restores it.
- [ ] 🔴 `archive.spec.ts`:
  - the creator archives the room and both users see the read-only banner;
  - history is still scrollable to the beginning;
  - a user who is not the creator has no Archive action;
  - Unarchive brings the composer back.
- [ ] 🔴 `session.spec.ts`: a reload keeps the user logged in. Logging out goes to `#/login`, and going back shows no room content.
- [ ] 🔴 `reconnect.spec.ts`: B goes offline, A sends 80 messages, and when B comes back all 80 appear in order
- [ ] 🔴 `xss.spec.ts`: an `<img onerror>` payload renders as text and `window.__pwned` stays undefined, both after sending and after editing
- [ ] 🔴 `mobile.spec.ts`: at 390×844 the sidebar collapses, the composer is visible, and sending works
- [ ] 🔴 `a11y.spec.ts`: axe on the login, rooms, room and archived-room screens finds 0 serious or critical issues
- [ ] (optional) `perf.spec.ts`: with 4× CPU throttling, the first message is visible in under 1.5 s
- [ ] CI runs e2e on all three browsers
- [ ] `README.md`: setup, dev, test, build, and deployment (systemd unit, `serve <domain>`, backups) (§11)

**✅ Gate 7 — MVP done:** CI is green on `main`. Every box above is ticked, and every requirement in DESIGN.md §2 and §13 is traceable to at least one test.

---

## Requirement → test traceability

| Requirement (DESIGN §13) | Integration | Unit | E2E |
|---|---|---|---|
| Anyone can create rooms | 1.3 | 4.1 | signup |
| Hide rooms (personal, silent) | 1.8 | 2.5, 4.2 | hide |
| No email verification | 1.2 | — | signup |
| Edit own messages | 1.6, 1.9 | 5.6 | edit |
| Soft delete with placeholder | 1.7, 1.9 | 2.4, 5.7 | realtime |
| Archive instead of delete (creator only) | 1.3, 1.4, 1.5 | 4.3, 5.8 | archive |
| Archived names never reused | 1.4 | — | — |
| Full history to the beginning | 1.10 | 2.4, 5.4 | history |
| Realtime and reconnect | 1.9 | 5.3, 5.5 | realtime, reconnect |
| XSS safety | — | 3.1 | xss |
| Fast and minimal | — | 0.5 (budget) | perf (optional) |
