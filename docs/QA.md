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
