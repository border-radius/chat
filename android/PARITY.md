# Parity with the web app

Each web e2e spec (`tests/e2e/`) and the Android tests that cover the same behaviour (ANDROID.md §13). A web feature
without an entry here fails review. **Covered**: the scenario runs on the app's screens (Robolectric, against a real
PocketBase). **Partial**: the behaviour is tested below the screens (API, services, room controller), or only some of
the spec's cases are. **Not yet**: no Android test.

Test classes: `UiFlowTest`, `UiFeaturesTest`, `RoutesTest` (`app/src/test`); `ServicesTest`, `ChatApiTest`, the
`lib` tests (`core/data/src/test`).

| Web spec | Android | Status |
|---|---|---|
| `smoke` | `UiFlowTest`: log in, open a room, send, the server has it | Covered |
| `signup` | `UiFeaturesTest`: signing up logs you in; `ChatApiTest`: sign up | Covered |
| `session` | `UiFlowTest`: a wrong password says so; `ServicesTest`: logging out clears the session's data | Partial: a session revoked elsewhere, two sessions |
| `accounts` | `UiFeaturesTest`: renaming yourself | Partial: password change |
| `avatar` | — | Not yet (the photo picker can't be driven on Robolectric) |
| `realtime` | `UiFlowTest`: a live message; `ServicesTest`, `ChatApiTest`: realtime events | Covered |
| `reconnect` | `ChatApiTest`: reconnect after a pause says events may have been missed | Partial: gap fill after it |
| `history` | `ServicesTest`: opens around a message far back, jumps to the latest | Partial: scrolling the edges |
| `unread` | `ServicesTest`: live counts, read on the server | Partial: the badge and the "New" line on screen |
| `edit` | `UiFeaturesTest`: edit, delete; `ServicesTest`: edit, delete | Covered |
| `reactions` | `UiFeaturesTest`: quick reactions; `ServicesTest`; `HelpersTest`: the web's reaction cases | Covered |
| `replies` | `UiFeaturesTest`: reply and its quote; `ChatApiTest` | Partial: going to the original |
| `forward` | `UiFeaturesTest`: forwarding one message; `ChatApiTest` | Partial: several at once, delete together |
| `dm` | `UiFeaturesTest`: a new DM from the people search; `ChatApiTest` | Partial: close and reopen |
| `hide` | `UiFeaturesTest`: hiding a room | Partial: unhide |
| `archive` | `UiFeaturesTest`: an archived room is read-only; `ServicesTest` | Covered |
| `room_access` | `UiFeaturesTest`: private with a member; `ChatApiTest` | Partial: who can post, Open Air |
| `attachments` | — | Not yet (pickers; the outbox sends files: `Outbox`) |
| `search` | `UiFeaturesTest`: find and go to a message far back; `TextTest`: the web's search cases | Covered |
| `cache` | `ServicesTest`: the room is kept for next time | Partial: opening from it |
| `urls` | `RoutesTest`: links to rooms and messages | Covered |
| `xss` | `LinksTest`: only http(s) become links. Compose shows text as text: there is no HTML to inject | Covered |
| `a11y` | — | Not yet (content descriptions are set; no automated check, no TalkBack pass) |
| `mobile` | — | Not applicable: the web's narrow layout |
| `pwa` | — | Not applicable: the app is the installed app (§3) |
| — (Android only) | Servers and accounts (ANDROID.md §17): `AccountsTest`, `ServersTest` (add, switch, links and pushes find their account, refused sessions, addresses), `UiAccountsTest` (add an account on another server, switch from the profile, a bad address, log out to another account) | Covered |
| — (Android only) | `push.test.ts` (server): who gets a push, ids only, tokens owner-only, App Links, minimum version | Covered on the server; not yet on a device |
