# The client API

What the clients (web/, android/) rely on from the server. The Android app is installed and updated by its users, on
their own schedule (F-Droid), so a release of the server has to keep working with the apps already out there.
Anything listed here is a public interface. A change to it needs the compatibility check below, not just green
tests.

Shared values live in [`shared/contract.json`](../shared/contract.json): the field lists, limits and file types. Each
client keeps its own copy, and tests compare those copies with the contract:
- `tests/unit/contract.test.ts` checks the web's copy and the hooks' copy.
- `android/…/lib/ContractTest.kt` checks the app's.
- `tests/integration/schema.test.ts` checks the limits against the migrations.

Rules that more than one implementation must follow have test vectors in [`shared/vectors/`](../shared/vectors/):
- `text.json`, `jump.json`: text folding, search queries, Jump to's ranking. The web, the hooks and the app run them.
- `window.json`: the message window (merge, trim, pages, groups, page queries; DESIGN.md §7.5). The web
  (`tests/unit/lib/window-vectors.test.ts`) and the app (`WindowVectorsTest.kt`) run it. Messages in it are written out
  or generated as `tests/support/vectors.ts` says.
- `room.json`: the room controller against a real server (open, page, jump, go to, live messages, pill, unread line,
  deletes). Recorded from the web's controller (`RECORD=1 npx vitest run --project component
  tests/component/views/room/scenarios.test.ts`) and replayed by it and by the app's `RoomScenariosTest.kt`. A change to
  what the controller does is recorded again, then the app is made to pass.

## What the clients use

**Record API** (`/api/collections/{name}/records`). PocketBase's API rules decide access:

| Collection | Web | App | How |
|---|---|---|---|
| `users` | ✓ | ✓ | auth (password, refresh), sign-up, profile update (`fields.user`) |
| `rooms` | ✓ | ✓ | list, get, create, update (`fields.room`) |
| `messages` | ✓ | ✓ | pages by cursor filter (`lib/cursor.ts`, `Cursors.kt`), get, create (multipart), update, search (`text_key ~`) (`fields.message`) |
| `hidden_rooms` | ✓ | ✓ | list, create, delete (`fields.roomRow`) |
| `site` | ✓ | ✓ | the site record; the app also reads `min_android_version` |
| `collections`, `collection_items` | ✓ | ✓ | the collections pages (`fields.collectionItem`) |
| `push_tokens` | | delete only | apps from before ANDROID.md §21 unregister their Firebase token |

The clients send filters in PocketBase's filter syntax. The filters name the fields `room`, `created`, `id`,
`updated`, `files`, `forward_of`, `text_key` and `collection`. Renaming a field, changing its type or tightening a
rule breaks the apps already installed.

**Custom routes** (`pb_hooks/main.pb.js`, `federation.pb.js`):
`/api/chat/dms`, `unread`, `unread/{room}`, `reads`, `reactions`, `delete`, `forward`, `media/{room}`,
`posters/{message}/{file}`, `posters/items/{item}/{file}`, `collections`, `badges`, `items`, `items/{id}`, `saved`,
`subs`, `subs/seen`, `users`, `password`, `remote-users`. Also `/api/files/*` (with a file token), `/api/health` and
`/.well-known/assetlinks.json`.

**Realtime** (`/api/realtime`): `rooms`, `messages` (one room's, or every room's with `fields.activity`),
`hidden_rooms`, `room_reads`, `collections`, `collection_subs`, `chat/badges` and `PB_CONNECT`.

Routes only the server or tests call: the `*/tick` routes (superusers), `/api/fed/*` (other instances, §33) and
`/api/telegram/webhook`.

## Changing it

- **Adding** a field, a route or an optional parameter is safe. Clients ask for named fields (`fields=`), so they
  never see a new field until they ask for it.
- **Renaming or removing** anything in the tables above: keep the old form working until no supported app version
  uses it. Then raise `site.min_android_version`, which tells older apps to update (ANDROID.md §12.4).
- **Tightening** a rule or a limit: older apps check against the old limit, so the server's own error message is
  what their users will see. It must still read well.
- A field list in `shared/contract.json` changes together with both clients' copies. The contract tests fail until
  all three match.
