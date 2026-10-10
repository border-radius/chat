# Refactoring TODO

Architecture review of the MVP, 2026-10-10. The foundations are good: one SDK seam (`api.ts`), pure logic in
`lib/`, a real-backend test harness, an XSS sink guard and a size budget. Most items below are about **where
state and lifecycle live**. Today every view repeats its own copy of them.

Ordered by value ÷ effort. Each item should keep `npm run check` and e2e green, and should land on its own.

**Progress:** items 1, 2, 3, 5, 6 and 7 are done; 4 is done except for the optional DOM-free controller; parts of 11 are done.
New modules: `sync.ts`, `actions.ts`, `context.ts`, `scope.ts`, `ui/menu.ts`, `views/room/{header,messages,composer}.ts`.

---

## P1 — Structural

### 1. Stop remounting the sidebar on every room switch ✅
- [x] The router keys views by the full hash, so going from `#/r/a` to `#/r/b` unmounts the whole `withSidebar`
      layout (`app.ts:21`). The rooms view then refetches `listRooms` + `listHidden`, re-subscribes to realtime
      and rebuilds the "New room" form, which loses any half-typed name.
- [x] Fix: add an optional `update(params)` to `View`. The router calls it when the next route has the same *view factory* and
      only the params change. `withSidebar` forwards it to the pane only, and the sidebar stays mounted.
- [x] Have `matchRoute` return the `Route` itself instead of a pattern string that is then looked up again
      (`router.ts:59-60`). That also removes the `route!` / `m!` assertions.

### 2. Move room/hidden data sync out of views and into an app-level service ✅
- [x] `rooms.ts` and `room.ts` both subscribe to `rooms`, so the room page holds **two** identical realtime
      subscriptions. Both also implement "reload on reconnect".
- [x] Add `web/src/sync.ts`: on login it loads rooms and hidden rows, subscribes once, and refetches on reconnect.
      On logout it tears everything down. Views only read `store` and call commands.
- [x] This also gives a single place to show a "reconnecting…" status later.

### 3. One home for room commands and store mutations ✅
- [x] `setRoom` exists in both views. Hide, unhide, archive and unarchive are implemented twice, with slightly
      different store updates: `room.ts:322` filters by roomId, `rooms.ts:63` filters by rowId.
- [x] Add `web/src/actions.ts`: `createRoomActions({ api, store })` returning `hide(room)`, `unhide(room)`,
      `setArchived(room, bool)`, `createRoom(name)`. Each one makes the API call and the store update. The views
      keep only the UI around them (menus, error text).
- [x] Put store mutators next to the store, for example `upsertRoom`, `removeRoom`, `setHidden` and
      `clearHidden` in `store.ts`, so the immutable `new Map(...)` copying lives in one place.

### 4. Split `views/room.ts` (804 lines) — mostly done
It currently holds the window state machine, loading, realtime, the composer, edit/delete, the header menu and
rendering. Suggested split:
- [ ] *(optional, remaining)* `room/controller.ts`: window, `gen`, buffer, `open` / `jump` / `loadEdge` / `gapFill` / `onMessage` / send /
      edit / delete. No DOM. It emits "changed" with a hint (`anchor`, `scrollToBottom`, `pill`). Most of
      `tests/unit/views/room.test.ts` (867 lines) can then become fast controller tests.
- [x] `room/messages.ts`: the list element, sentinels, `messageNode` + signature cache, day dividers, and the
      edit/delete-confirm/error UI state, plus its focus handling.
- [x] `room/composer.ts`: textarea, counter, Enter/Up-arrow handling, `validText` (shared with edit).
- [x] `room/header.ts`: title + actions menu, built on the shared menu component (item 5).
- [x] `views/room.ts` (412 lines): the window state machine, loading, realtime, send/edit/delete, and wiring.

### 5. Extract the "actions menu with confirm step" component ✅
- [x] `rooms.ts:116-194` and `room.ts:278-379` both build a `<details>` menu with Escape-to-close, an inline
      "Archive …? / Archive / Cancel" confirm, and focus restore through `focusAfter` selectors.
- [x] Add `web/src/ui/menu.ts`: `actionMenu({ label, items, signal })`, where an item can be
      `{ label, run }` or `{ label, confirm: { text, action, run } }`. The component owns open/confirm state and
      focus restore, so callers stop passing selector strings around.

### 6. Fix the loading race in the room view ✅
- [x] `open()` / `loadAround()` assign `win` **before** checking `gen` (`room.ts:464, 474`). If "Jump to
      beginning" runs while the first load is still in flight (the menu is rendered at mount, before `ready`),
      the late `open()` result overwrites the window that `jump` loaded.
- [x] Make every loader return a `MessageWindow` and commit it in exactly one place, behind the `gen` / `active`
      check. Add a unit test: jump("first") during a slow initial load.

---

## P2 — Consistency and duplication

### 7. A view lifecycle helper ✅
Every view has the same fields: `ac`, `active`, `subs: Promise<Unsubscribe>[]`, `offStore`, `offConnect`, and an
`unmount` that walks through them.
- [x] Add `web/src/scope.ts`: `const scope = createScope()` with `scope.signal`, `scope.active`,
      `scope.defer(fn)` and `scope.sub(promise)` (awaits and unsubscribes when disposed), plus `scope.dispose()`.
      `unmount` then becomes `scope.dispose(); clear(root)`.
- [x] Remove `dom.ts`'s `on()` and its test. Nothing in `web/src` uses it, and `h(..., { on, signal })` covers it.

### 8. Actually abort in-flight requests on unmount
- [ ] DESIGN §7.2 says unmount aborts fetches. In practice `autoCancellation(false)` is set, only `api.page`
      accepts a signal, and `room.ts` never passes one. Results are dropped by the `active`/`gen` guards, but the
      requests still run.
- [ ] Give every read method in `Api` an optional `signal`, and pass `scope.signal` (item 7).

### 9. Shared limits and error text
- [ ] Limits live in several places: message max 2000 (`room.ts:24`, migration), name max 32 (`login.ts:25`,
      migration), room name max 48 (`rooms.ts:236`, migration), password min 8 (`login.ts:27`). Move them to
      `web/src/lib/limits.ts`, and add an integration test asserting the live schema matches them (field
      `max`/`min` from `/api/collections`).
- [ ] "Can't reach the server…" / "Something went wrong…" are written out separately in `login.ts` and
      `rooms.ts`, and differently again in `room.ts`. Add `describeError(err, overrides?)` next to `ApiError`.
- [ ] `rooms.ts:22` matches the server's English string `"Value must be unique."`. Match the validation **code**
      instead (`validation_not_unique`): keep `code` on `ApiError.fields` in `toApiError`.

### 10. Keep SDK details in `api.ts`
- [ ] `lib/cursor.ts` exports `MSG_FIELDS` and `listOptions()` with `expand: "author"`. That is SDK knowledge
      leaking into a pure module, and it duplicates `msgOpts` in `api.ts`. Keep `cursor.ts` as filter + params +
      sort only, and build list options inside `api.ts`.
- [ ] `PAGE_SIZE` is used by both the query and the "is this page full?" logic. Keep it in `lib/`, but have
      `applyPage` take `pageSize` explicitly (easier to test with small pages).

### 11. Small cleanups in `room.ts` / `messages.ts`
- [x] `loadOlder` / `loadNewer` are near-identical. Use one `loadEdge("top" | "bottom")`.
- [x] `applyLoaded` is `async` but never awaits. Make it sync.
- [ ] ~~`[...win.items].reverse().find(...)` → `findLast`~~: needs `lib: es2023`; the target is es2022, so skip unless the browser floor is raised.
- [x] Selectors are built with raw ids (`msgSel`, `room.ts:267, 497`) while `scroll.ts` uses `CSS.escape`. Pick
      one helper (`byDataId(id)`).
- [x] `editable()` is computed twice per message per render (signature + actions). Compute it once in
      `messageNode`.
- [ ] Module-level `let uid = 0` counters in three views → one `uniqueId(prefix)` in `dom.ts`.

### 12. Typed errors at boundaries
- [x] `app.ts:110` types the refresh error as `{ status?: number }`. `refreshAuth` already throws `ApiError`, so
      use `instanceof ApiError`.
- [ ] `e.action as Action` appears three times in `api.ts`. Add one `subscribe<T>(collection, opts, fn)` helper.

---

## P3 — Tooling

### 13. Share the esbuild config between build and dev
- [ ] `scripts/build.mjs` and `scripts/dev.mjs` both list the entry points, `format`, `target` and `bundle`.
      Export `baseOptions` from `scripts/lib/build-utils.mjs`. `ENTRIES` is already there in spirit.

### 14. Typecheck the server code
- [ ] `pb_hooks/` and `pb_migrations/` aren't in `tsconfig.include`, and their `types.d.ts` reference points into
      the git-ignored `pb_data/`. Generate the types into a tracked or cached path (`types/pocketbase.d.ts`) in
      `npm run setup`, and add a second tsconfig project for the JSVM files (`checkJs`, no DOM lib).

### 15. A real linter/formatter
- [ ] There is no formatter or linter beyond the grep-based sink check. Add Biome (one dev dependency, fast,
      format + lint). Express the HTML-sink ban as a lint rule if practical, otherwise keep the script.

### 16. Test helper duplication
- [ ] `uniq()` and the "fresh client with in-memory auth" helper exist in both `tests/support/api.ts` and
      `tests/integration/helpers.ts`. Move them to `tests/support/`.
- [ ] CI builds twice: `npm run check` builds, then Playwright's `webServer` runs `npm run build` again. Use
      `E2E_SKIP_BUILD=1` or split the webServer command.

### 17. Docs ↔ code coupling
- [ ] Code comments cite `§7.5` and `TODO 3.5`. Those section numbers break when the docs are edited, and
      `docs/TODO.md` is a finished build plan (148 items checked). Archive it as `docs/history/BUILD_PLAN.md`,
      keep DESIGN.md as the living spec, and refer to sections by name rather than by number.
- [ ] Update DESIGN §7.2 and §7.4 after items 1–3 and 7 (`update(params)`, `sync.ts`, `actions.ts`, scopes).

---

## Not recommended

- **Adding a UI framework.** The `h()` + `reconcile()` approach fits the 25 KB budget and the strict no-HTML-sink
  rule. The friction comes from duplicated lifecycle and menu code (items 5 and 7), not from missing reactivity.
- **Merging the API rules and the hooks.** The overlap, such as the archived checks in both, is deliberate
  defense in depth for superuser writes.
