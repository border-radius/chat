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
