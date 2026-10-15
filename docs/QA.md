# QA pass — avatars, direct messages, attachments

Exploratory QA of the post-MVP features (DESIGN.md §15–§17), 2026-10-10, against a production build on a fresh
PocketBase 0.40.4, in Chromium (desktop 1100×720 and phone 390×844), plus probes of the REST API. Numbering continues
the MVP QA pass (BUG-01 … BUG-23, cited in the tests). Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-24 | **High** (security) | Uploads | A tiny image with huge dimensions exhausts server memory when thumbnailed | Fixed |
| BUG-25 | Medium | Attachments | After a page reload, every attachment image fails once before loading | Fixed |
| BUG-26 | Medium | Uploads | Prepared images are WebP, so every thumbnail is served as a large PNG; transparent PNGs turn black where WebP can't be encoded | Fixed |
| BUG-27 | Medium | Attachments | Dropping a file anywhere but an open room makes the browser open the file and leave the app | Fixed |
| BUG-28 | Medium | Attachments | Original file names are lost ("Quarterly Report (final).pdf" shows and downloads as "quarterly_report_final.pdf") | Fixed |
| BUG-29 | Medium | DMs | Just opening a DM (no message sent) makes it appear in the other person's sidebar | Fixed |
| BUG-30 | Low | DMs | "Message" always calls the server, even for a DM that is already open, and any failure says "Check your connection" (also on rate limiting) | Fixed |
| BUG-31 | Low | Composer | Opening the attachment tray (or the textarea growing) pushes the newest messages out of view | Fixed |
| BUG-32 | Low | Mobile | A long author name pushes the message time off screen | Fixed |
| BUG-33 | Low | Profile | A name or avatar change in one tab isn't shown in the app bar of the user's other tabs | Fixed |
| BUG-34 | Low | DMs | "%" in the user search is a wildcard: searching "%" lists everyone, "100%" finds nothing | Fixed |

---

## BUG-24 — Image "decompression bomb" exhausts server memory (High, security)

**Steps:** as any logged-in user, upload as an avatar (or attachment) an 875 KB PNG declaring 30000×30000 pixels
(a single-colour image compresses to almost nothing), then request its thumbnail (`?thumb=48x48`).

**Expected:** the upload is refused, or thumbnailing is cheap.
**Actual:** the thumbnail request takes 6.3 s and PocketBase's memory peaks at **4.6 GB**. Memory grows with the
declared pixel count, so a ~2 MB avatar (or 8 MB attachment) declaring 50000×50000 or more gets the process killed
for running out of memory. Avatar thumbnails are public, so once uploaded, anyone can re-trigger it, and parallel
requests multiply it.

**Cause:** PocketBase decodes the whole image to make a thumbnail, and nothing limits image dimensions (only file
size, which a compressed bomb easily stays under).

**Fix:** the upload hooks read the header of every uploaded PNG, JPEG, GIF and WebP (the formats PocketBase
thumbnails) and reject images over 25 megapixels (`validation_image_too_large`). The app's own uploads are at most
2048 px on the longest edge (§15.3), about 4 megapixels, so they're never affected.

## BUG-25 — Attachment images fail once after every reload (Medium)

**Steps:** open a room with image attachments, reload the page.
**Expected:** the images load.
**Actual:** each image request first gets 404, then the error handler fetches a new token and the retry loads it:
2 failed requests for 2 images in the probe, a visible flash, and twice the requests.

**Cause:** the file-token cache is cleared on every auth-store change, including the background session refresh
that runs on every page load. The refresh lands while the room's first token request is in flight, so that token is
thrown away and the first render builds URLs without a token.

**Fix:** clear the cache only when the logged-in user actually changes.

## BUG-26 — WebP uploads make PNG thumbnails; transparent PNGs can turn black (Medium)

**Steps:** attach a photo; look at the size and type of the thumbnail Bob's browser loads.
**Actual:** the browser re-encodes every image as WebP (§15.3). PocketBase can't write WebP, so every thumbnail of a
WebP is a PNG: for photo-like content the 480×360 "thumbnail" (35 KB) was bigger than the whole 2000×1500 upload
(25 KB). Separately, where WebP can't be encoded (Safari) the fallback is JPEG, which has no transparency: a
transparent PNG (logo, screenshot with alpha) gets a black background.

**Fix:** keep PNGs as PNG and turn everything else into JPEG. Both are formats PocketBase thumbnails in their own
format, and PNG keeps transparency.

## BUG-27 — A stray file drop navigates away from the app (Medium)

**Steps:** drag a file from the desktop and drop it on the room list, the profile page outside the picture, or an
archived room.
**Expected:** nothing happens (or it attaches, in an open room).
**Actual:** the browser's default action opens the file in the tab, leaving the app (and anything half-typed).
`dragover` was only cancelled over an open room's composer area.

**Fix:** the app cancels the browser's default for file drags and drops on the whole page; the room and the profile
picture still handle their own drops.

## BUG-28 — Original file names are lost (Medium)

**Steps:** attach "Quarterly Report (final).pdf".
**Actual:** it shows, and downloads, as "quarterly_report_final.pdf". PocketBase stores a normalized name plus a
random suffix, and the app could only strip the suffix (§17.5).

**Fix:** a new `messages.file_names` JSON field, set by the create hook from each upload's original name (so the
client can't forge it) and mapping stored name → original name. The list shows and downloads files under their
original name, falling back to the old behaviour for messages sent before the fix. (Prepared images keep their
name; only the extension follows the new format.)

## BUG-29 — An empty DM appears in the other person's sidebar (Medium)

**Steps:** Ada opens a DM with Bob from the user search (or by clicking his name → Message) and sends nothing.
**Actual:** "Ada" appears under Direct messages in Bob's sidebar right away, for a conversation with no messages:
noise, and confusing if Ada clicked the wrong person.

**Fix:** a DM without messages is listed only for the member who opened it. It appears for the other one with its
first message (`last_message_at` is set, and the realtime update brings it in).

## BUG-30 — "Message" always calls the server; misleading error (Low)

**Steps:** click an author's name → Message for someone you already have an open DM with; repeat for a few people.
**Actual:** every click calls `POST /api/chat/dms` (limited to 10 per minute per IP, which a whole office behind one
NAT shares). When it fails for any reason, including 429, the text is "Check your connection".

**Fix:** go straight to an open DM that is already in the room list, without a request. Errors use the shared
`errorMessage()` (which has a rate-limit sentence).

## BUG-31 — The newest messages get hidden when the composer grows (Low)

**Steps:** scroll to the bottom of a busy room, attach a file (or type several lines).
**Actual:** the tray (or the taller textarea) shrinks the list from below, so the newest message slides under the
composer and the list is no longer at the bottom.

**Fix:** when the list's height changes and it was at the bottom, keep it at the bottom.

## BUG-32 — Long author names push the time off screen on phones (Low)

**Steps:** at 390 px width, view a message from "Bob Builderson Longname-Smith".
**Actual:** the time is cut off ("10:55 P"). Another user's name is now an author menu (`<details>`), which doesn't
shrink, so the name no longer truncates with an ellipsis as it did before.

**Fix:** the author menu shrinks, and its name truncates with an ellipsis.

## BUG-33 — Profile changes don't reach the user's other tabs (Low)

**Steps:** open the app in two tabs; change your display name or avatar on `#/me` in one.
**Actual:** the other tab's app bar keeps the old name/avatar until a reload. The shared session does update (tabs
share it), but the app ignored auth changes that keep the same user id.

**Fix:** an auth change for the same user still updates the logged-in user's name and avatar in the store.

## BUG-34 — "%" is a wildcard in the user search (Low)

**Steps:** in "New message", search for "%", then for "100%".
**Actual:** "%" lists every user; "100%" finds nobody, even a user called "Load 100%". PocketBase's `~` treats a `%`
in the value as a wildcard (and then stops adding its own), while `_` is already escaped.

**Fix:** escape `%` in the search text.

---

## Checked and fine

- Non-members can't reach a DM or its files by any API path tried (view, list, realtime, expand, file token, hiding
  it); a new message can't reference another message's stored file by name.
- Uploaded HTML/SVG is a sandboxed download; avatar uploads are checked by content, not by extension.
- Retrying a failed upload re-sends the same id and files and can't post twice.
- WebP and GIF thumbnails work; a 6000×6000 image thumbnails in 0.2 s (BUG-24 is about far larger ones).
- Up arrow edits a files-only message (empty text), and editing keeps its attachments.

Known, not fixed here: an emoji-less system (this test container) shows the file chip's "📄" as a box; a browser that
already loaded an attachment can keep it in its cache after the message is deleted (DESIGN §17.1).

---

# QA pass 3 — whole app

Exploratory QA of the whole app, 2026-10-11, on PocketBase 0.40.4: REST and hook probes (rules, hooks, DMs, unread
counts, uploads) and Chromium at desktop and phone sizes, light and dark. Beforehand, the whole suite passed: typecheck,
lint, html-sink check, 401 unit, 192 integration, build and 23 e2e tests. Each fix comes with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-35 | Medium | Attachments | A file whose non-Latin name is over 255 bytes can never be sent | Fixed |
| BUG-36 | Low | Attachments | Names cut at the 200-character limit lose their extension | Fixed |
| BUG-37 | Low | DMs | An empty DM the other member opened first is missing from your list, even while you are in it | Fixed |
| BUG-38 | Low | Names | Line breaks, tabs, control characters and runs of spaces are kept in room and display names | Fixed |
| BUG-39 | Low | Rooms | Every failed room action says "Check your connection", whatever the reason | Fixed |
| BUG-40 | Low | Login | A wrong password says "Failed to authenticate." | Fixed |
| BUG-41 | Low | Rooms | Rooms whose names clashed before `name_key` existed can't be archived or unarchived | Fixed |
| BUG-42 | Low | Composer | Text made only of zero-width characters enables Send; the server refuses it and Retry never works | Fixed |

## BUG-35 — Long non-Latin file names can't be sent (Medium)

**Steps:** attach "Протокол совещания Протокол совещания … .pdf" (152 characters, 291 bytes) and send it.
**Actual:** "Not sent", and Retry fails every time. The same happens with an emoji or accented name over about 250 bytes,
and with avatars.
**Cause:** PocketBase stores the original name as file metadata, cut at 255 bytes. The cut can split a multi-byte
character, and the storage layer then refuses the invalid UTF-8 (`WriterOptions.Metadata values must be valid UTF-8`).
**Fix:** the create hooks (messages and users) clean each upload's original name and cut it to 200 UTF-8 bytes, on a
character boundary, before PocketBase stores it.

## BUG-36 — Cut names lose their extension (Low)

**Steps:** attach a file named with 70 × "報告書" + ".xlsx".
**Actual:** it shows and downloads as "報告書…報告書報.t". The 200-character cap was a plain `slice`.
**Fix:** the cut keeps the extension (up to 16 characters) and shortens the rest of the name.

## BUG-37 — An empty DM is missing from the second opener's list (Low)

**Steps:** Bob opens a DM with Ada and sends nothing. Later, Ada clicks Bob → Message.
**Actual:** the DM opens for Ada, but it isn't listed under Direct messages, so there's no highlighted row. The BUG-29
fix lists an empty DM only for its creator.
**Fix:** an empty DM is also listed while it is the open room.

## BUG-38 — Control characters and repeated spaces in names (Low)

**Steps:** create a room named "two\nlines" (through the API), then "two lines" and "two  lines".
**Actual:** three separate rooms that look identical on screen, because HTML shows a line break or a run of spaces as one
space. That is the kind of look-alike name the QA fixes in BUG-12 meant to prevent. Display names have the same problem.
**Fix:** names (and attachment names) turn control characters into spaces and every run of whitespace into one space.

## BUG-39 — "Check your connection" for every failed room action (Low)

**Steps:** hide, archive or close rooms quickly until the server rate-limits you (or it refuses for another reason).
**Actual:** the sidebar says "Couldn't hide … Check your connection and try again.", and the room header says "That
didn't work. Check your connection…", even on a 429. BUG-30 fixed this for "Message" only.
**Fix:** both use `errorMessage()`, which explains network trouble, rate limits and the server's reason.

## BUG-40 — "Failed to authenticate." on a wrong password (Low)

**Fix:** a refused login says "Wrong email or password."

## BUG-41 — Legacy look-alike rooms can't be archived (Low)

**Steps:** have two rooms whose names clashed before the `name_key` migration (e.g. "Über" and "über"). The migration
kept both, giving the second a key made unique with its id. As that room's creator, archive it.
**Actual:** "Value must be unique." Every room update re-checked the name, even when it didn't change.
**Fix:** the name is checked only when it changes. Otherwise the stored key is kept, and a client still can't set it.

## BUG-42 — Zero-width-only messages (Low)

**Steps:** paste only a zero-width space into the composer and press Enter.
**Actual:** it sends, the server refuses blank text, and the message shows "Not sent" with a Retry that can never work.
**Fix:** the composer treats such text as empty, as the server does. Joiners inside real text still count as text.

## Checked and fine

- Rules: other users' messages, rooms, hidden rows and read positions can't be read or changed. Nobody can un-delete,
  move or hard-delete a message, or post as someone else. Nobody can create DMs, archived rooms or room_reads rows
  through the API, or set `created`/`file_names`. Changing email or `verified` directly is refused.
- DMs: nothing reaches a non-member: view, list, expand, post, hide, mark read.
- Unread: counts skip your own and deleted messages, and anything from before you signed up. A read can't be moved back
  or into the future, and bad dates are refused.
- User search: `%`, `_`, `\`, quotes and `{:x}` are matched literally.
- Live archive/unarchive while someone is typing keeps the draft. Deep links to a message in another room, or to a
  missing room, fall back cleanly. Offline sends fail and then retry without duplicates.

Known, not fixed here: a renamed user's old name stays in other people's open DMs and already-loaded messages until
they reload (nothing pushes user changes). The per-IP limit of 120 reads a minute may be tight for a large office
behind a single NAT.

---

# QA pass 4 — whole app

Exploratory QA of the whole app, 2026-10-11, on PocketBase 0.40.4. It used scripted multi-user Chromium sessions
(desktop 1100×720 and phone 390×844, light and dark, several tabs per user), axe on states the e2e suite doesn't
cover, and REST, hook and migration probes. Beforehand, the whole suite passed: typecheck, lint, html-sink check,
432 unit and 207 integration tests, and the build. Each fix comes with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-43 | Medium | Editing | An open edit box loses what you typed (and its focus) whenever its message is redrawn | Fixed |
| BUG-45 | Medium | Session | A tab left open longer than the session lasts looks logged in, but nothing can be sent | Fixed |
| BUG-47 | Medium | Accounts | Emails are case-sensitive: "Ada@x.com" can't log in as "ada@x.com", and can sign up twice | Fixed |
| BUG-44 | Low | Rooms | With every room hidden or archived, the list says "No rooms yet. Create the first one." | Fixed |
| BUG-46 | Low | Menus | "⋯" and author menus stay open after a click elsewhere, pile up and cover messages | Fixed |
| BUG-48 | Low | Rooms | A room created as "#random" is shown as "##random", next to a different "random" | Fixed |
| BUG-49 | Low | Signup | Signing up with an email that is taken says "Value must be unique." | Fixed |
| BUG-50 | Low | Composer | A half-typed message is lost when you look at another room and come back | Fixed |

## BUG-43 — The edit box forgets your typing (Medium)

**Steps:** follow a link to one of your messages (or click a reply's quote), click Edit and type for a few seconds.
Or: edit a reply of yours while the author of the message it quotes edits theirs.
**Actual:** after 3 s the highlight fades, the message is redrawn, and the edit box is back to the original text,
without focus. The same happens on any redraw of that message (quoted message edited, midnight).
**Fix:** the list keeps the typed text, and gives the rebuilt box back the focus and caret. Escape (not while composing
with an input method) still discards it.

## BUG-45 — Expired sessions fail silently (Medium)

**Steps:** stay on the app, without reloading, for longer than the users' token lifetime (7 days by default; reproduced
with 20 s).
**Actual:** the app still shows you logged in. Every send ends in "Not sent." and Retry never works. Only the page load
renewed the session.
**Fix:** the app renews the session halfway through its lifetime (at least daily), and again when the tab comes back to
the foreground (timers are late while a computer sleeps). It retries after a network failure. A session that has
already expired goes to the login screen instead of failing quietly.

## BUG-47 — Emails depend on their capitalization (Medium)

**Steps:** sign up as "Mixed@Test.Local", log out, log in as "mixed@test.local". Or sign up again with the lower-case address.
**Actual:** "Wrong email or password." The second signup succeeds, so the same mailbox has two accounts.
**Fix:** new emails are stored in lower case (users create hook). A login whose email matches nobody as typed is
looked up in lower case (`onRecordAuthWithPasswordRequest`). A migration lowers existing emails, except for pairs
that already differ only in case. Those keep their addresses, and each still logs in as typed.

## BUG-44 — "No rooms yet" while rooms exist (Low)

**Steps:** hide (or archive) every room. **Actual:** "No rooms yet. Create the first one." above "Hidden (4)".
**Fix:** "No other rooms. Hidden and archived ones are listed below." whenever those sections aren't empty.

## BUG-46 — Menus never close on their own (Low)

**Steps:** open a room's "⋯", the header's "⋯" and an author's name menu, then click into the messages.
**Actual:** all three stay open. The author menu's "Message" covers the message text.
**Fix:** an open menu closes on a pointer press or focus anywhere outside it.

## BUG-48 — "##random" (Low)

**Steps:** New room → "#random". **Actual:** the room is titled "##random", and "random" can still be created next to
it. **Fix:** leading "#"s (and spaces) are dropped from room names on save. "c#" keeps its inner "#".

## BUG-49 — "Value must be unique." on signup (Low)

**Fix:** "There is already an account with this email. Log in instead."

## BUG-50 — Drafts lost on switching rooms (Low)

**Steps:** type a message, click another room to look something up, come back. **Actual:** the composer is empty.
**Fix:** unsent text is kept per room (in memory, for the session; cleared on logout or a user switch).

## Checked and fine

- Two tabs of one user: sends, reads and unread badges stay in sync. Logging out in one logs out the other.
- DMs: opened from the search, the first message brings it to the other person with a badge. A closed DM comes back on
  the next message.
- History: scrolling back to the first message of a 180-message room, jumping to the beginning, "New messages · Jump
  to latest", sending from the beginning, the pill while scrolled up, and deep links scrolled forward to the live edge.
- Attachments: image thumbnail plus a PDF under its original name, and a 0-byte file. Replying to a files-only
  message, and the reply bar closing when that message is deleted.
- No horizontal overflow from 400-character words or long URLs, at desktop or phone width.
- axe (WCAG 2.1 AA): no violations with the reply bar, delete confirm, header menu or edit box open, at both widths
  and in both themes.
- Limits: 2000 emoji in a message, 32 in a name, 48 in a room name.

Known, not fixed here: the document title never shows unread counts.

---

# QA pass 5 — whole app

Exploratory QA of the whole app, 2026-10-12, on PocketBase 0.40.4: scripted multi-user Chromium sessions (several
devices and tabs per user, desktop 1100×720 and phone 390×844, light and dark), axe on states the e2e suite doesn't
cover (profile errors, emoji picker, selecting, bulk-delete confirm, forward dialog, user search, new room), and REST
probes of the rules and routes. Beforehand, the whole suite passed: typecheck, lint, html-sink check, 505 unit and 248
integration tests, the build, and e2e (except the known local timeouts in `reactions.spec.ts`). Each fix comes with a
test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-51 | Medium | Session | After a password change, other devices still look logged in: nothing arrives, every send is "Not sent" | Fixed |
| BUG-52 | Medium | Realtime | After a password change, the user's other tabs (and the sidebar of the tab that changed it) stop updating live | Fixed |
| BUG-55 | Medium | DMs | The user search ignores case only for ASCII: "иван" doesn't find "Иван" | Fixed |
| BUG-53 | Low (security) | Accounts | A password can be changed through the users API, around the route's rate limit and checks | Fixed |
| BUG-54 | Low | Attachments | A file named `Q&A "v2".txt` shows and downloads as `Q&A %22v2%22.txt` | Fixed |
| BUG-56 | Low | Profile | After "This display name is taken", putting your own name back leaves the error showing | Fixed |
| BUG-57 | Low (a11y) | Theme | Red text on a hovered button (Delete, Log out, confirms) is 4.25:1, under WCAG AA's 4.5:1 | Fixed |
| BUG-58 | Low | Selecting | A failed delete of several messages always says "Check your connection", even when rate limited | Fixed |

## BUG-51 — Signed-out devices don't know it (Medium)

**Steps:** be logged in on two devices. On one, change the password (the page says "You were logged out everywhere
else"). Use the other.
**Actual:** it still shows you logged in. No new messages arrive, and everything you send ends in "Not sent." with a
Retry that never works, until you reload. The token was revoked, but the app only checked its session on load and when
it neared expiry, and a revoked token gets 400/404 on writes (PocketBase treats it as no session), not 401.
**Fix:** when the server refuses a change sent with the session (400, 401, 403, 404), the app checks the session (at
most every 30 s); it also checks when the tab comes back after 5 minutes. A revoked session goes to the login screen.

## BUG-52 — Other tabs go quiet after a password change (Medium)

**Steps:** two tabs of the same browser in a room. Change the password in one; have someone post.
**Actual:** the other tab gets the new token (tabs share the session) but never shows the message, and its badges stop
updating, until you switch rooms or reload. The tab that changed it loses its sidebar's live updates the same way.
**Cause:** PocketBase knows who a realtime client is from the token its subscriptions were sent with. The old one was
revoked, and the subscriptions were only sent again when they changed.
**Fix:** the realtime client sends its subscriptions again whenever the session token changes.

## BUG-55 — User search is case-sensitive outside ASCII (Medium)

**Steps:** New message (or Forward) → search "иван" for a user called "Иван", or "élodie" for "Élodie".
**Actual:** nobody found. The search was `name ~ q`, and SQLite's `LIKE` only ignores the case of ASCII letters.
**Fix:** a `GET /api/chat/users?q=` route matches the query's name key against `users.name_key` (NFKC, case folded,
§22.1), so "иван", "ИВАН" and "Иван" are the same, and "strasse" finds "Straße". It answers only id, name and avatar.

## BUG-53 — Password changes around POST /api/chat/password (Low, security)

**Steps:** `PATCH /api/collections/users/records/<me>` with `oldPassword`, `password`, `passwordConfirm`.
**Actual:** 200: the password changes at the generic limit (300 requests per 10 s), not the route's 5 per minute, so a
stolen session could guess the current password far faster. It also skipped the route's "same password" check.
**Fix:** the users update rule refuses `password` and `passwordConfirm`. The route saves directly, so it still works.

## BUG-54 — `"` in file names becomes `%22` (Low)

**Steps:** attach `Q&A "v2".txt`. **Actual:** shown and downloaded as `Q&A %22v2%22.txt`. Browsers escape `"` (and line
breaks) in multipart file names, per the HTML spec. **Fix:** the upload hooks undo that escaping before keeping the name.

## BUG-56 — A stale "taken" error on the profile (Low)

**Fix:** saving your current name clears the error (there is nothing to save).

## BUG-57 — Low contrast of red text on hover (Low, accessibility)

**Steps:** hover a red button (a message's Delete, the bulk-delete confirm, Log out). **Actual:** `#d1213b` on the hover
background `#e9e4fb` is 4.25:1. **Fix:** the light theme's red is `#c41d36` (4.74:1 hovered, 5.65:1 on the page). A unit
test checks red text against every background token in both themes.

## BUG-58 — "Check your connection" for every failed bulk delete (Low)

**Steps:** delete selected messages more than 20 times in a minute. **Actual:** "Couldn't delete those messages. Check
your connection and try again." on a 429. BUG-39 fixed this elsewhere. **Fix:** it says why, with `errorMessage()`.

## Checked and fine

- Forwarding: to a room, an existing DM and a new DM (found by name), with attachments and from a reply; Bob gets the
  DM live with a badge and can open the copied files. Nothing can be forwarded from or into someone else's DM, into an
  archived room, or more than 50 at once; duplicate ids forward once.
- Selecting and deleting several of your own messages, with the confirm step; others' messages can't be deleted.
- Drafts survive switching rooms and a reload, and are gone once sent. The tab title and favicon follow unread counts,
  DMs included.
- Signup with a taken name (in another case) says so; names are tidied ("  Fresh   Person  " → "Fresh Person").
- Room names made only of "#" are refused; a hidden room can't be hidden twice; replies can't point into another room.
- No horizontal overflow at 390 px; axe found nothing else in the states listed above.

Known, not fixed here: in the forward dialog, the first Escape in a non-empty search field clears it (the browser's
behaviour for search fields) and the second closes the dialog.

---

# QA pass 6 — room access: private rooms, Open Air rooms, guests

Testing of §23 while building it, 2026-10-12, on PocketBase 0.40.4 in Chromium (1100×720 and a 390×844 phone, light
and dark): integration probes of every rule and route as a member, a non-member, a removed member, the creator and a
guest (no session); unit tests of the views; Playwright runs with several users and a guest side by side; axe on the
guest home, guest room, sign up, the room list's new-room form and the access dialog. Numbering continues from BUG-58.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-66 | **High** (privacy) | Realtime | After logging out, the tab goes on receiving the previous user's live events: their DMs and private rooms show up in the guest's room list | Fixed |
| BUG-59 | Medium | Session | After a logout, the next login (anyone's) lands on the page the previous user was on: their profile, or a private room's URL | Fixed |
| BUG-60 | Medium | Room access | A room that went away while open stays "You can't see this room any more" after access comes back, and clicking it in the list does nothing | Fixed |
| BUG-61 | Medium | Rooms | A message sent while a room is opening can be missed until the next reconnect (likelier for a guest following a link) | Fixed |
| BUG-67 | Medium | Realtime | A connection replaced while still connecting (BUG-66's restart, or a reconnect) could fail the new connection's subscriptions | Fixed |
| BUG-62 | Low | Session | Logging out reset the session twice (two `unsubscribeAll` requests) | Fixed |
| BUG-63 | Low | Performance | Every DM message made the server go through every realtime client, looking for someone who lost access | Fixed |
| BUG-64 | Low (a11y) | Room access | Each visibility radio button's name was its whole explanation | Fixed |
| BUG-65 | Low | Mobile | The new-room form's visibility select used 13.6 px text, which makes iOS Safari zoom in on focus | Fixed |

## BUG-66 — A logged-out tab still gets the previous user's events (High, privacy)

**Steps:** Ada logs out (the tab now shows the guest view). Bob then writes to Ada in their DM and adds her to a
private room. **Expected:** the guest view shows neither. **Actual:** both rooms appear in the guest's room list,
live; anyone at the computer sees Ada's DM and private room names (and the DM partner).
**Cause:** the realtime connection outlived the session. Logging out dropped the subscriptions on the client, the guest
view subscribed again on the same connection, and PocketBase refused that request (403: "the current and the previous
request authorization don't match"), leaving the connection subscribed as Ada. The guest's room-list listener has the
same subscription key as Ada's, so it got her events. Before guests existed, nothing subscribed after a logout.
**Fix:** when the session changes to another user, or to none, the client closes the realtime connection and opens a
new one (`restart()` in `pb.ts`); a new token for the same user still just resends the subscriptions (BUG-52). Found
by a `403` in the output of a unit test, then reproduced with a probe.

## BUG-59 — The next login lands on the previous user's page (Medium)

**Steps:** Ada opens her profile (or a private room) and logs out; Bob logs in on the same tab.
**Expected:** Bob lands on the home page. **Actual:** he lands on Ada's last page, `#/me` (or the private room's URL,
which says it doesn't exist).
**Cause:** the page to go back to after logging in (so a guest returns to the room they were reading) was only updated
on `hashchange`; logging out moves home with `history.replaceState`, which fires none.
**Fix:** logging out resets it to home. Found by `session.spec.ts`.

## BUG-60 — A room that comes back stays gone (Medium)

**Steps:** a guest reads an Open Air room; its creator archives it (the guest sees "You can't see this room any
more."), then unarchives it. **Expected:** the room shows again. **Actual:** the message stays, and clicking the room,
which is back in the list, does nothing: it is the URL already open, so nothing remounts. Same for a member taken out
of a private room and added back.
**Fix:** a room view showing "gone" or "doesn't exist" starts the page over once the room is in the list (again).
Found by `room_access.spec.ts`.

## BUG-61 — A message sent while a room opens can be missed (Medium)

**Steps:** open a room (as a guest, from a link) while someone posts in it. **Expected:** the message shows.
**Actual:** sometimes it never does, until a reconnect or a reload.
**Cause:** the first page and the realtime subscription are set up side by side. A message created after the page was
read but before the server had the subscription reaches neither. With a warm connection the window is one request;
a guest's first page load also opens the realtime connection, which makes it several round trips. Found while
investigating a flaky `room_access.spec.ts` run, and shown by a unit test that holds the subscription back (it fails
without the fix). That flaky run itself turned out to be the spec's own race: it typed into the composer while the
modal access dialog was still saving, so the message was never sent; the spec now waits for the dialog to close.
**Fix:** when the subscription is ready only after the page, the room fetches anything newer than its newest message
once (no request otherwise, no scrolling unless at the bottom).

## BUG-67 — A replaced connection fails the new one (Medium)

**Found:** `npm run check` stopped on an unhandled rejection ("Missing or invalid client id", 404) after the BUG-66 fix.
**Cause:** when a connection is closed while its connect handler is still sending the subscriptions (a restart for
another user, or a reconnect), the server forgets that client and answers 404. The handler's error path then ran
against the *new* connection: it rejected the new connection's pending subscribes (the unhandled rejection: the room
list or a room got no live updates) and could close the new connection. Before BUG-66's fix only an ill-timed
reconnect could do this.
**Fix:** each connection's handlers check that it is still the current one before touching any state.

## BUG-62 to BUG-65 (Low)

- **BUG-62:** logging out ended the session, then the auth change ended it again: two `unsubscribeAll` requests. Ending
  a session that isn't running now does nothing.
- **BUG-63:** the hook that tells clients they lost access ran on every room save, and DM messages save their room.
  It returns early when visibility, archived, creator and members are unchanged.
- **BUG-64:** the radio buttons' labels held the explanation too ("Private Only the people you add can read and
  post."). They are labelled by the name and described by the explanation.
- **BUG-65:** the select was 0.85 rem; fields stay at 16 px (§22, QA pass 5).

## Checked and fine

- Non-members of a private room can't list, view, filter, expand into, subscribe to (by `*` or by id), post in, react
  in, forward into, hide or mark read the room, or download its attachments; neither can guests. A member taken out
  loses all of it, including editing and deleting what they wrote there, and gets a realtime delete for the room; the
  others get the update, everyone else nothing.
- Only the creator changes visibility and members; the creator can't be removed; duplicate and unknown members, more
  than 100, and changes to a DM are refused or cleaned up; the members list is dropped when a room stops being private.
- Guests list and read Open Air rooms only, with authors (no emails), reactions, replies and attachments (thumbnails
  and full files, without a token), live; never public, private or archived ones, DMs, user lists, unread counts or
  file tokens. A guest's view drops an Open Air room as soon as it is archived or made public, and gets it back live.
- Logging in or signing up from a room returns to it; `#/me` as a guest asks to log in and returns there; logging out
  goes home as a guest; an expired session goes to the login page.
- axe: no violations in the states above, light and dark. No horizontal overflow at 390 px.

Accepted, not fixed: room names stay unique across all rooms, so trying to create a room under a private room's name
says it is taken (§13, room access).

---

# QA pass 7 — found while refactoring (docs/REFACTOR.md round 3)

Not an exploratory pass: these turned up as flaky tests while the test suites were reorganized, 2026-10-13, and each
was traced to its cause before being fixed (a stack trace per request, the test server's own request log). Each fix
lands with a test that fails without it. Numbering continues from BUG-67.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-68 | Medium | Realtime | A session renewal (or password change) answered after a logout closed the guest's new connection: no live updates, no reconnect | Fixed |
| BUG-69 | Medium | Rooms | A room list reload answered after live events undid them: a room you were taken out of was listed again, an archive undone | Fixed |
| BUG-70 | Low | Attachments | Leaving a room while a message with attachments was sending kept its previews in memory | Fixed |

## BUG-68 — A late resubmit closes the new connection (Medium)

**Found:** unhandled `PbError` rejections from `pb.ts` in full unit runs, after a logout.
**Cause:** BUG-67 made each connection's connect handler check that it is still the current one, but `resubmit()`
(which sends the subscriptions again whenever the token changes: every session renewal, a password change) had no such
check. Answered after its connection was replaced (a logout in between), its failure went to `connectError` while the
new connection had no client id yet: that rejected the new connection's subscribes and closed it, with no reconnect
scheduled. `scope.sub()` also left a failed subscribe unhandled until the scope was disposed.
**Fix:** `resubmit()` ignores a failure once `es` is no longer the connection it was sent for; `scope.sub()` catches at
once (the realtime client keeps the subscription and sends it on the next connection). Tests: `pb.test.ts` (a fake
EventSource and fetch play renew, log out, late 404), `scope.test.ts`.

## BUG-69 — A reload undoes live room events (Medium)

**Found:** `access.test.ts` "taken out of a private room while in it" saw the room come back, now and then.
**Cause:** `sync.ts` reloads the room list on start and on every reconnect, and its answer replaced the list in the
store. Live events that arrived while it was in flight are newer than that answer and were lost: a room you were taken
out of was listed again (and the view, seeing it back, reopened it), an archive was undone. An older reload answering
after a newer one overwrote it too.
**Fix:** events received during a reload are applied again on top of its answer, in the same store update (one by one,
the room would vanish and come back, which the view takes for access regained), and an answer older than the one in
the store is dropped, as `unread.ts` already did for counts. Tests: `sync.test.ts`.

## BUG-70 — Previews kept after leaving a room mid-send (Low)

**Found:** a flaky check in `room/attachments.test.ts` that the preview was released.
**Cause:** a sent message's preview URLs were released when `api.send` answered, after the room view's scope check. The
realtime echo can replace the pending copy before that answer; leaving the room in between skipped the release, and
nothing else held those previews any more.
**Fix:** released as soon as the server has the message, before the scope check (`room/controller.ts`).

## Also found: test fixtures writing to the database

Not an app bug, but it looked like one: message edits and deletes failing with 400 "Failed to update record." under
load, logged by PocketBase as `database is locked (517)`. The test helpers wrote to `data.db` from other processes,
which can commit inside one of the server's transactions; PocketBase itself sends every write through one connection.
Fixture writes now go through the test server (docs/REFACTOR.md item 30).

---

# QA pass 8 — exploratory, whole app

Exploratory testing of the whole app, 2026-10-13, on a production build and a fresh PocketBase, in Chromium (desktop
1100×720 and a 390×844 phone, light and dark), with two or three users side by side, slowed or failing requests
(Playwright routes, CDP network throttling), probes of the REST API and the custom routes, and axe on states earlier
passes didn't list (emoji picker, image viewer, selecting, editing, delete confirm, forward dialog). Numbering
continues from BUG-70. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-74 | Medium | Realtime | If the realtime connection failed as the page loaded, it was never tried again: no live messages, room list or unread counts, and nothing said so | Fixed |
| BUG-71 | Medium | Sending | Messages sent close together could land out of order: a message with an attachment ended up after the text sent just after it, for everyone | Fixed |
| BUG-76 | Medium | Sending | A message whose send failed after you had opened another room vanished: no "Not sent", and it was gone from the composer and the draft | Fixed |
| BUG-72 | Medium | Editing | Two quick edits of a message, the first slow to arrive, saved the older text: the latest edit was lost | Fixed |
| BUG-73 | Medium | Forwarding | People you share a private room with (but have no DM with) couldn't be found in the Forward dialog: "Nothing found." | Fixed |
| BUG-77 | Medium | Composer | In Safari, the Enter that confirms a word typed with an input method (Japanese, Chinese…) sent the message | Fixed |
| BUG-75 | Low | Profile | Renamed in another tab, the profile still showed the old name, and Save quietly undid the rename | Fixed |
| BUG-78 | Low (a11y) | Emoji | The picker's category headings were h3s under the room's h1 (axe: heading-order) | Fixed |

## BUG-74 — No live updates after a failed first connect (Medium)

**Steps:** open the app while the realtime request fails once (a network blip, a proxy dropping the stream), then let
it through. Bob posts in the open room. **Expected:** the message shows. **Actual:** nothing ever arrives; the room list
and unread counts stay frozen too, with no error, until a reload or opening another room.
**Cause:** `pb.ts` reported a failed *first* connect to the subscribers and then stopped, so as not to retry forever.
Nothing else tried again: the subscriptions it kept were only sent by a later `subscribe()`.
**Fix:** it reports the failure and then retries like after a lost connection. That later connect counts as a reconnect
(`realtime.recovered`), so the room list, unread counts and open room fetch what they missed.

## BUG-71 — Messages land out of order (Medium)

**Steps:** attach a 3 MB file and send it, then send a short text right away (any slow network). **Expected:** the
file's message, then the text. **Actual:** the text reached the server first, so it was saved first: the sender saw the
two swap places once sent, and everyone else got them in the wrong order. Two plain texts swapped the same way when the
first request was slow. **Cause:** every send went out at once; the server orders messages by when it saves them.
**Fix:** the room's sends go one at a time, in order (a slow upload makes the next message wait for it).

## BUG-76 — A send failing after you left the room is lost (Medium)

**Steps:** send a message, open another room before it is through, and let the request fail. Go back.
**Expected:** the message shows as not sent, with Retry. **Actual:** it is gone, and so is the text: the composer and
the saved draft were cleared on sending. **Cause:** the failure was ignored once the room's view had gone.
**Fix:** such a message is kept (`strays` in `room/controller.ts`) and the room's next view shows it as not sent, with
Retry and Discard. Its attachments come along (shown by name, as their previews went with the old view). A reload still
loses it, like unsent text before.

## BUG-72 — An older edit overwrites a newer one (Medium)

**Steps:** edit a message and save; edit it again and save before the first save is answered (slow network).
**Expected:** the second text stays. **Actual:** when the first request was the slower one, the server saved it last:
the message (for everyone, and for you once answered) showed the first edit. **Fix:** a message's edits, deletes and
reactions go one at a time (reactions already did, §20.3).

## BUG-73 — Forward can't find people you share a private room with (Medium)

**Steps:** Ada and Bob are in a private room, with no DM between them. Ada forwards a message and searches "Bob".
**Expected:** Bob, to start a DM. **Actual:** "Nothing found." **Cause:** the dialog leaves out people found by name
whom it already offers as a DM, but it took everyone in *any* room you see (private rooms list their members) for a DM
partner. **Fix:** only the other member of each DM counts.

## BUG-77 — Safari sends while you pick a word with an input method (Medium, Safari)

Not reproduced here (no WebKit locally); found by reading the key handling and checked against WebKit's known
behaviour. **Steps:** in Safari, type Japanese with the system input method and press Enter to confirm a word.
**Expected:** the word is confirmed. **Actual:** the half-written message is sent. **Cause:** the composer (and the edit
box) skip Enter while `isComposing`, but Safari ends the composition before that keydown, which then only has
`keyCode` 229. **Fix:** `composing()` checks both.

## BUG-75 and BUG-78 (Low)

- **BUG-75:** with your profile open in two tabs, renaming yourself in one left the old name in the other's field
  (the header did follow, BUG-33); pressing Save there renamed you back, saying "Saved.". The field now follows a
  rename made elsewhere, unless you are typing a new name in it.
- **BUG-78:** the emoji picker's category headings were `h3`s right under the room's `h1`. They are `h2`s.

## Checked and fine

- Sending, editing, replying, deleting, reactions and their live updates between two users; 12 messages typed as fast
  as possible keep their order; an offline send fails, keeps its text and is sent by Retry; edits and deletes made
  while offline show after reconnecting, and so do new messages.
- 420-message room: scrolling down from the first message and back up loads every page, no duplicates, at most 300
  in the DOM; a quote of the very first message jumps there and offers "Jump to latest".
- Image viewer: arrow keys through a message's images and on, stops at the end, Escape gives focus back to the
  thumbnail; attachments that aren't images show as download chips.
- New room form (leading "#"s and spaces tidied, duplicates and over-long names refused), private room with members
  added in the access dialog (live for the new member, read-only member list for them), Open Air room read by a guest,
  log in from there returns to it, signup errors (taken name and email).
- Unread counts and the tab title, rooms and DMs, while away and back; avatars (upload, refused file, remove).
- REST probes: emails can't be filtered or expanded by others; `verified`, `created`, other users' rooms and fields
  the rules guard can't be set; the custom routes refuse malformed bodies, dates and ids with 400/404 (no 500s); user
  search treats `%`, `_` and `\` as text. Odd URLs (`/#//example.com`, malformed escapes, trailing slashes) land home.
- No horizontal overflow at 390 px; axe: nothing else in the states above, light and dark.

---

# QA pass 9 — forwarding, then the rest of the app

Exploratory testing focused on forwarding (§21.3), 2026-10-13, on a production build and a fresh PocketBase, in
Chromium (desktop 1100×720 and a 390×844 phone, light and dark), with two or three users side by side, slowed or failing
forward requests (Playwright routes), and probes of `POST /api/chat/forward` and of what a forward's readers can read.
Numbering continues from BUG-78. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-80 | Medium (privacy) | Forwarding | Whoever could see a forward (a guest in an Open Air room too) could read, on its original, who reacted to it and which message it replies to, in a private room they can't see | Fixed |
| BUG-79 | Medium | Forwarding | A selected message deleted while the Forward dialog was open made the whole forward fail | Fixed |
| BUG-81 | Low | Forwarding | A refused forward or bulk delete said "Failed to forward the messages." instead of why ("A message was deleted.", "This room is archived…") | Fixed |
| BUG-82 | Low | Forwarding | A forward whose original was deleted still had Forward, which always failed | Fixed |
| BUG-83 | Low | Forwarding | The Forward dialog listed rooms as "# #name"; long names ran out of its list (and out of New message's) | Fixed |
| BUG-84 | Low (keyboard) | Selecting | After selecting messages by clicking them, Escape no longer stopped selecting | Fixed |

## BUG-80 — A forward's readers learn who is in the original's room (Medium, privacy)

**Steps:** Ada and Cy are in a private room. Cy reacts to Ada's message, which replies to an earlier one; Ada forwards
it to an Open Air room. Anyone (no account needed) reads `GET /api/collections/messages/records/<original>`, which the
view rule allows readers of the forward (§21.3). **Expected:** that message's words and attachments. **Actual:** also
its `reactions` (Cy's user id, so who is in the private room) and its `reply_to`. **Fix:** `keepToRoom` (an
`onRecordEnrich` hook) empties both in any answer to someone who can't see the message's room. It costs a room lookup
only for messages that have reactions or reply to one.

## BUG-79 — A message deleted meanwhile fails the whole forward (Medium)

**Steps:** select Bob's message and yours, press Forward; Bob deletes his; pick a room. **Expected:** yours is
forwarded. **Actual:** "Couldn't forward. Failed to forward the messages." and nothing is forwarded; the selection had
already dropped Bob's message (§21.1), but the dialog kept the ids it opened with. **Fix:** picking where to forward
leaves out messages deleted since (and forwards whose original was); when none are left, the dialog says "A message was
deleted." and sends nothing.

## BUG-81 to BUG-84 (Low)

- **BUG-81:** the forward and delete routes say what is wrong per field (`messages`, `room`, `user` for a new DM), and the
  client showed only the general message. Both failures now show the server's reason (`reasonOf` in `api.ts`).
- **BUG-82:** "The original message was deleted" forwards had Forward in their pill; the server refuses them (400).
  They keep Reply, reactions and Delete.
- **BUG-83:** rooms' titles start with "#", and the dialog put a "#" icon before them. Rooms now show their name next to
  the icon. A name too long for the list (search results here and in New message) ends in "…".
- **BUG-84:** a click on a message toggles it but left focus on the page itself (a message isn't focusable), outside
  the room, where Escape isn't heard. Focus now goes to that message's checkbox, as with Select.

## Checked and fine

- Forwarding one message from its pill and several from the selection, into another room, the same room ("Message
  forwarded."), a DM, a DM you had closed (it reopens, live for the other person too), someone found by name, and from a
  DM into a room; the selection's order kept; Back afterwards.
- Edits and deletes of the original show live in its forwards and in replies quoting them, also after a reload;
  forwarding a forward points at the original; a forward can't be edited; unread counts and the tab title count a forward
  once and never again for edits of its original.
- Forwarded images: thumbnails, and the viewer paging through them, served from the original; gone when it is deleted.
- The dialog: searching (by name, with "#", spaces only, your own name finds no one), a slow forward that can't be
  cancelled (Cancel disabled, Escape refused), a network failure shown and tried again; 390 px, dark.
- REST: forwarding into or from a room you can't see (404), deleted messages (400), archived targets (400), 51 ids that
  are the same message (one forward), bad bodies (400), anonymous (401); a forward's reader can't forward or react to
  the original by id.
- Unit, integration and Chromium e2e suites, before and after the fixes.

---

# QA pass 10 — the installable app (PWA), then the rest of the app

Exploratory testing of the PWA (§27), 2026-10-14, then of the rest of the app with a focus on what came since pass 9
(audio attachments, bigger attachments, `no_dms`, the Telegram bridge). A production build on fresh PocketBase servers,
in Chromium (desktop 1100×720 and a 390×844 phone, light and dark), with two users side by side, the network taken
offline and slowed, a simulated deploy, Chrome's own installability check, axe on every main screen, and a second server
running the bridge against the stub Bot API (`tests/support/telegram.ts`). Numbering continues from BUG-84. Each fix
lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-86 | Medium (impersonation) | Telegram | Anyone could sign up or rename themselves "Ann Lee (TG)" and pass for a Telegram person, here and in the groups; the real Ann then became "Ann Lee 2 (TG)" | Fixed |
| BUG-85 | Low | Realtime | Opening the app offline (now common: §27) or with the server down threw three unhandled "Something went wrong." errors | Fixed |
| BUG-87 | Low | Telegram | An edit that made a caption longer than Telegram's 1024 characters was refused by Telegram and lost | Fixed |
| BUG-88 | Low | Telegram | A service message (a new group photo, a timer, a topic) made a stand-in for whoever did it, a member of a linked private room | Fixed |
| BUG-89 | Low | Telegram | A group becoming a supergroup lost its room when the new group's notice came before the old one's | Fixed |
| BUG-90 | Low (accessibility) | Rooms | "This room doesn't exist." (and "You can't see this room any more.") had no heading | Fixed |
| BUG-91 | Low (security) | Telegram | The webhook secret was compared with `!==`, not in constant time | Fixed |

## BUG-86 — Anyone could pass for a Telegram person (Medium, impersonation)

**Steps:** with the bridge on, sign up as "Ann Lee (TG)"; Ann Lee writes in a linked Telegram group. **Expected:** only
Telegram people are named "… (TG)". **Actual:** the signup is accepted; Ann's stand-in becomes "Ann Lee 2 (TG)", and
what the impostor writes goes to the group as "**Ann Lee (TG)**". **Fix:** while the bridge is on, a users create or
update request naming someone "… (TG)" (compared as names are: case, full-width forms, spaces) is refused with "Names
ending in (TG) are for people on Telegram." under the name field, on the signup form and the profile alike. Superusers
are not held to it, and a name already taken is kept (only a change is checked).

## BUG-85 — Unhandled errors when the first connect fails (Low)

**Steps:** open the installed app (or a tab) offline, or with the server down. **Expected:** "Couldn't load rooms" with
Retry, and nothing else. **Actual:** that, plus three uncaught `PbError: Something went wrong.` in the console (one
each from the room view, the room list and the unread counts). **Cause:** `api.onConnect()` subscribes to
`PB_CONNECT`, which rejects when the first connect fails (QA BUG-74), and only caught that when unsubscribing.
**Fix:** it catches it at once; the realtime client goes on trying, and the app recovers by itself once online (checked).

## BUG-87 to BUG-91 (Low)

- **BUG-87:** a message with files is sent with its text as their caption when it fits, but an edit could make it longer.
  The edit's caption is now cut to 1024 characters, ending in "…".
- **BUG-88:** `bringOver` made the sender's stand-in (and a member of a private room) before finding there was nothing
  to bring over. It now returns first.
- **BUG-89:** Telegram tells of a migration in both groups. Only the old group's notice moved the link, and not when
  the new group had been heard from first (its own, unused link was in the way). Either notice now moves it, an unused
  link in the way is replaced, and messages queued for the old id follow.
- **BUG-90:** the not-found and gone pages are a heading and a line of links, so a screen reader's heading list finds
  them as it finds a room's name.
- **BUG-91:** `$security.equal`, as for the invite code (§24.2).

## Checked and fine

- **PWA:** Chrome finds no installability errors and parses the manifest; the site title names the app; every icon
  loads with its type. Logged in and offline, a reload keeps the session and shows the shell; back online, rooms,
  the open room and live messages return without Retry. A simulated deploy: the next load takes the new build, the old
  build's assets leave the cache, and the new one opens offline. The API, the admin UI, `/_` (redirected), odd paths
  and the manifest pass through untouched. Every phone screen has its own way back (an installed iOS app has no back
  button).
- **Audio:** plays on through a reaction and an edit of its message, stops once the message is deleted; a file
  request refused mid-play (an expired token) gets a new token and carries on from the same time.
- **Attachments:** 10 files at most (the 11th says so), over 20 MB refused by name, "+6" on the fourth tile, the viewer
  paging through all ten.
- axe (WCAG 2.1 AA) on the guest home, login, signup, home, a room, the emoji picker, the room menu and the profile, light
  and dark, desktop and phone: nothing; no horizontal overflow at 390 px.
- Telegram: a wrong secret (401), text with HTML in it, a stand-in posting in a private room (a member, as designed).
- Unit, integration and Chromium e2e suites, before and after the fixes.

Not verified: on a notched iPhone in landscape, the app bar and room list have no side safe-area padding
(`viewport-fit=cover`), so their edges may sit under the notch. Chromium can't show it.

---

# QA pass 11 — the room cache, prefetching and opening at the first unread message

Exploratory testing of what came since pass 10 (§7.5 room cache, its prefetching, §18.5 opening at the first unread
message), 2026-10-14, then a sweep of the rest. A production build on a fresh PocketBase server, in Chromium (desktop
1100×720 and a 390×844 phone), with two users side by side, several tabs of one browser, held and slowed requests,
rapid room switching, a user switch in another tab, the rate limiter turned on, and up to 320 rooms with unread
messages. Numbering continues from BUG-91. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-93 | Medium | Unread | Loading the app straight into a room (a reload, a restored tab, a link) opened it at the bottom and took every unread message as read | Fixed |
| BUG-94 | Medium | Prefetching | With many rooms unread at login, prefetching used up the per-IP request limit: rooms opened meanwhile said "Couldn't load this room. Check your connection." | Fixed |
| BUG-95 | Medium (privacy) | Room cache | A message deleted while you were in another room showed its full text again when you opened the room, until the first page was in | Fixed |
| BUG-92 | Low | Prefetching | While any room got a message at least once a second, no room was ever prefetched | Fixed |
| BUG-96 | Low | Room cache | Scrolled to the bottom of a kept window that opened at the "New" line, the first page pulled you back up to the line | Fixed |

## BUG-93 — A reload skipped the unread messages (Medium)

**Steps:** Bob reads a room and closes the tab; Ada writes 80 messages; Bob opens the room's address (or reloads it,
or the browser restores the tab). **Expected:** the room opens at the first of the 80, under the "New" line (§18.5).
**Actual:** it opened at the bottom, with no line, and the read went out at once: 60 of the 80 were never on screen and
the room showed nothing unread. **Cause:** the room only asks where its unread messages start when the store has a
count for it, and just after a page load the counts aren't in yet. **Fix:** the store's `unread` starts as
`UNCOUNTED`; while it is, a logged-in room view asks the server. That is one more request before the first page on
such a load (as for any room opened with a badge).

## BUG-94 — Prefetching used up the rate limit (Medium)

**Steps:** with the rate limiter on, log in as someone with 320 rooms with unread messages, and open rooms from the list.
**Expected:** they open. **Actual:** prefetching fetched all 320 back to back; 46 requests were refused with 429, and
9 of 15 rooms opened meanwhile showed "Couldn't load this room. Check your connection." PocketBase's limit for
`/api/` is per IP (300 per 10 s), so it is shared with everyone behind the same address. **Fix:** rooms are fetched 250 ms
apart (at most 40 per 10 s), and a refused fetch ends the run; the rest is fetched when their counts next go up.

## BUG-95 — The cache showed deleted messages (Medium, privacy)

**Steps:** Bob is in another room; Ada writes "my password is hunter2" in a room Bob has kept (or that was prefetched
for him), then deletes it; Bob opens that room on a slow network. **Expected:** "Message deleted" (a deleted message
must never show its text, §7.5). **Actual:** the text, until the first page replaced the window. **Fix:** prefetching
also follows message deletes (the unread service's text-free events, §18.3) and refetches the room, so the cache holds
it deleted. A delete made while the app was closed still shows until the first page is in: nothing could tell it.

## BUG-92 and BUG-96 (Low)

- **BUG-92:** each count going up restarted prefetching's one-second wait, for every room together, so a room with a
  message every 600 ms kept every room from being fetched (none was kept in 8 s). The wait now starts with the first
  count and isn't restarted; messages meanwhile join the run, and a busy room is fetched about once a second.
- **BUG-96:** the first page scrolled a stale window to the first unread message whenever it was at the bottom, which is
  where you were if you had scrolled down to read. It now stays where it is; a kept window shown at the bottom with
  nothing unread still follows to the newest message.

## Checked and fine

- **Opening at the first unread message:** 120 unread under 70 read lands on the first, a quarter of the way down,
  and nothing is read until the bottom is on screen; then older and newer history load with no duplicates. With 1 or 3
  unread (also on a phone) everything is on screen and read at once. 99+ badges.
- **Room cache:** sending, a live message and a delete while the kept window shows; rapid switching through 8 rooms 3
  times (no message of another room shown, every room right afterwards); a guest's cache cleared at login; a user
  switched in another tab (nothing of the previous user kept, the tab follows); a deleted message's text never kept.
- Typecheck, lint, unit, integration and Chromium e2e suites, before and after the fixes.

Not fixed: a room's first load that fails for any reason (also 429 or 500) says "Check your connection", as the room
list does; with BUG-94 fixed it is rare. A message edited while you were away shows its old text until the first page
is in (the cache is "as it was last time"; edits can't be told from reactions in the text-free events).

---

# QA pass 12 — the room cache without waiting, service messages and the Telegram bridge

Exploratory testing of what changed on 2026-10-15 (the room cache shown without waiting for the network, §7.5, §18.5;
service messages, §5.3) and of the Telegram bridge (§26) in a browser, then a sweep. A production build on a fresh
PocketBase server with the bridge on against the stub Bot API (updates delivered to the webhook as Telegram does), in
Chromium (desktop 1100×720 and a 390×844 phone): every API request held or slowed, private rooms losing a member,
archived rooms, Telegram albums, edits, replies, oversize files and HTML in names, and a randomized run of two users
(one on a phone) sending, editing, deleting, reacting, switching rooms and reloading with 0–250 ms on every request,
then each client's view compared with the server. Numbering continues from BUG-96. Each fix lands with a test that fails
without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-100 | Medium | Room cache | A message sent (or edited) while a kept window showed vanished from your screen when the first page came | Fixed |
| BUG-98 | Medium (privacy) | Room cache | A room you lost access to showed its kept messages again on every load, until the server said no | Fixed |
| BUG-99 | Low | Room cache | Opening a room right after its badge went up put the "New" line on a message already read, then jumped | Fixed |
| BUG-97 | Low | Room cache | A room left (reload, tab closed) within a second of its last change wasn't kept, or was kept without that change | Fixed |

## BUG-100 — A message sent while the kept window showed vanished (Medium)

**Steps:** open a room that shows from the cache on a slow network, and send a message before its first page is in.
**Expected:** the message stays. **Actual:** it went from the list when the page came, though the server had it (a
reload showed it); an edit made meanwhile went back to the old text. Found by the randomized run (Ada's own edited
message missing from her view). **Cause:** the first page replaces the window and was asked for before the send; only
pending sends were carried over. The realtime echo puts a message back when it comes, but not when it was created
before the room's subscription was set up, and the catch-up fetch for that runs only when the subscription is set up
after the page. **Fix:** the newer copies of messages in the page's range (and after it, at the live edge) are kept over
the page's.

## BUG-98 — A room you lost access to kept showing from the cache (Medium, privacy)

**Steps:** Bob reads a private room; Ada takes him out of it; Bob reloads the room (or opens it from history).
**Expected:** "You can't see this room any more", and its messages not shown again. **Actual:** its kept messages and
name showed until the server answered, on every load. Came with showing the cache before the room list is in (the room
record is kept with it). **Fix:** a room that turns out not to be there, or that leaves the loaded room list, is saved
empty. What was kept shows at most once, for a moment, after access is lost while the app is closed.

## BUG-97, BUG-99 (Low)

- **BUG-97:** the window is saved a second after it last changed, so reloading, closing the tab or following a link
  sooner lost it (a room seen for the first time wasn't kept at all). It is now also saved on `pagehide`.
- **BUG-99:** with the counts in, the first unread message is worked out from the kept window, which was wrong when it
  hadn't been prefetched with that count (opened within the second before prefetching runs, or prefetching refused):
  the "New" line showed over a message already read until the server's answer moved it. Prefetching now saves the count
  it fetched for, and the kept window opens at the line only when that count is still the room's.

## Checked and fine

- **Service messages:** a centred line with no buttons, not selectable; reply, reaction, forward, delete, edit and a
  made-up one refused by the API; shown live to a private room's members only, and counted unread only for them.
- **Telegram bridge in the app:** an album of 4 photos as one message with its caption, a 47.7 MB file as a line of
  text, an edit and a reply from Telegram, a stand-in joining a private room; out to Telegram: names and text with
  `<b>` and `&amp;` escaped, a reply, an edit, a delete and a forward.
- **Layout:** a 1500-character word, a 520-character link, bidi overrides, 200 emoji and 40 lines on desktop and
  phone: nothing wider than the screen, long names cut short. Drafts survive a reload.
- **Randomized run** (120 steps each): before the fix, seed 3 found BUG-100 (seeds 2 and 4 were clean); after it, seeds 3 and 12 were consistent with the server in every room for both users.
- Typecheck, lint, unit, integration and Chromium e2e suites, before and after the fixes.

Not fixed: just after a reload, a kept room's record stands in until the room list is in, so a room archived meanwhile
shows its composer for that moment, and a message sent then fails with **Retry**. The sidebar lists only the kept room
until the room list is in.

---

# QA pass 13 — the room cache after the room-switching speedups

Exploratory testing of the room cache (§7.5) after 2026-10-15's changes (rooms not yet kept prefetched once the room
list is in, the cache held in memory too, the first page winning ties over kept copies), 2026-10-16. A production
build on a fresh PocketBase server, in Chromium (desktop 1100×720 and a 390×844 phone): two and three users, several
tabs of one browser, logouts and user switches, private rooms losing members, archived rooms, DMs, attachments,
every message request held or slowed (0–400 ms jitter), offline, back/forward cache, the rate limiter on with 80
rooms unread and 110 rooms in all, and a randomized run (Ada by API sending, editing, deleting and reacting in five
rooms; Bob in the browser switching, reloading, going back and sending, 0–250 ms per request), Bob's room compared
with the server after every step. Each scenario records every message text ever drawn, so a flash of the wrong text
counts. Numbering continues from BUG-100. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-101 | Medium (privacy) | Room cache | A private room you lost access to while the app was open, but weren't in, kept its messages: the next load straight into it showed them until the server said no | Fixed |
| BUG-102 | Medium | Unread | Reloading into a room whose kept window held its unread messages (prefetched) marked all of them read, though only the newest were on screen | Fixed |
| BUG-103 | Low | Room cache | After a reload, an author's new avatar or name never showed in a kept room: the kept copies beat the page's (and were kept again) | Fixed |
| BUG-104 | Low | Room cache | Leaving the page (a reload, a link, closing the tab) within a second of a room's last change often didn't keep it: the BUG-97 save on `pagehide` didn't reach IndexedDB | Fixed (mostly) |

## BUG-101 — A room you lost access to stayed in the cache (Medium, privacy)

**Steps:** Bob is in a private room's member list and has it kept (opened earlier, or prefetched); he is in another
room when Ada takes him out; later he reloads straight into the room (a bookmark, a restored tab). **Expected:**
"You can't see this room any more", and nothing of it. **Actual:** its messages showed until the server answered.
BUG-98 saved a room empty only when it was the open one; with prefetching of rooms not yet kept, most kept rooms are
never opened. **Fix:** any room that leaves the loaded room list while the app is open is saved empty
(`forgetGone`, cache.ts), for guests too.

## BUG-102 — A reload into a prefetched room read what was never on screen (Medium)

**Steps:** Bob is in the lobby; Ada writes 80 messages in a room, which is prefetched for him; Bob reloads straight
into that room. **Expected:** it opens at the first of the 80 under the "New" line, and they stay unread until he
reaches the bottom (§18.5, as BUG-93). **Actual:** the line was right, but all 80 were read: before the counts are
in, the kept window shows at the bottom, and what shows at the bottom counts as read. **Fix:** while a kept window
shows at the bottom before the server has said where the unread messages start (`unsure`), nothing counts as read;
with nothing unread, it is read as soon as the server says so.

## BUG-103 and BUG-104 (Low)

- **BUG-103:** the first page's copy of a message replaced a kept one only when it was newer (`updated`), so a kept
  room never picked up an author's new avatar or name, and kept the old one again. Found by avatar.spec.ts under
  load. Of the same age, the page's copy now wins; copies changed meanwhile (BUG-100) still stay.
- **BUG-104:** the window saved on `pagehide` (BUG-97, which had only a unit test) was put in a transaction made
  after a promise, and left to commit when the page next ran; when it was going, that often never came. Seen 3 times
  in exploratory runs and then not for ~70 tries alone, but a new e2e test failed 10 of 20 times at 4 workers (with
  IndexedDB calls logged: the put was made, and neither completed nor aborted). The transaction is now made at once
  once the database is open, and committed explicitly: 0 of 12 and 2 of 24 lost in the same setup. A write made as
  the page goes can still be lost under load; the room is then kept as it was a second earlier, or not at all.

## Checked and fine

- **Sessions:** logging out and another user logging in in the same tab, a user switch or a logout in another tab, a
  guest logging in: nothing of the previous user drawn, ever, and nothing of theirs kept.
- **Cached rooms:** rapid switching through 8 rooms 40 times with jitter (never another room's message); sending,
  replying, editing, deleting, deleting several, reacting, jumping to the beginning, scrolling into history and
  following a quote while the kept window shows; a message deleted while away (prefetched or warm-up kept) never
  shows its text; a deleted message can't be forwarded from a stale window; the "New" line opened before and after
  prefetching; DMs; images of a kept window after a reload; an archived room opened from the cache has no composer;
  two tabs of one user; back/forward cache; rate limiter on with prefetching (no 429, every room opened loads).
- **Randomized run** (seeds 1, 3, 5 on desktop, 2 and 6 on a phone; 40–60 steps each): Bob's room matched the server
  after every step, no page errors.
- Typecheck, lint, unit, integration and Chromium e2e suites, before and after the fixes.

Not changed, by design: a room whose first
load fails (offline) shows the error and **Retry**, not its kept window. A message edited (or reacted to) while you
were away still shows as kept until the first page is in.
