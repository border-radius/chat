# Chat

A small, fast, real-time group chat. One [PocketBase](https://pocketbase.io) binary is the whole backend
(auth, data, realtime, static files); the frontend is vanilla TypeScript bundled by esbuild — no framework,
~33 KB of JS gzipped.

- Public rooms anyone can create; hide rooms you don't care about; creators archive rooms (read-only, history kept)
- Room access, chosen by each room's creator: **Private** (only the people they add), **Public** (everyone with an account) or **Open Air** (anyone can read it, no account needed; the home page shows these rooms to guests, who log in or sign up to join in)
- Live messages, edits and deletes (deleted messages leave a placeholder)
- Full history: scroll back to the very first message of any room (windowed, ≤300 messages in the DOM)
- Direct messages between any two users, private to them; close a conversation and it comes back on the next message
- Avatars (or colored initials) and a profile page to change your picture, display name (unique) and password, and to log out
- Replies: answer any message with a quote of it; click the quote to jump to the original, however far back
- Links in messages are clickable and open in a new tab (http, https and www. addresses only)
- Emoji: a picker in the composer, and reactions on any message (as many different ones as you like), live for everyone
- Attachments: up to 4 files per message, images shown as thumbnails and videos as their first frame; files are private to whoever can read the message
- Image viewer: click a thumbnail to see it full size (or a video to play it) and step through the room's images and videos (buttons, arrow keys, swipe);
  loaded only when first used, so it adds nothing to the page's first load
- Select messages (up to 50): forward them to any room or DM, with "Forwarded from" and their attachments (forwards show the original, so nothing is copied), or delete them together when they are yours
- Unread counts on every room and DM, live, and in sync across your tabs and devices; the total shows in the tab's favicon and title
- What you were typing is kept per room, even across a reload; "Jump to latest" whenever you are scrolled up
- Your own branding (title and logo) and, if you like, invite-only signups: set by the admin in PocketBase
- Optimistic sending with safe retries, reconnect gap-fill, light/dark themes, works on phones

Design: [`docs/DESIGN.md`](docs/DESIGN.md) · QA: [`docs/QA.md`](docs/QA.md) · Refactoring plan: [`docs/REFACTOR.md`](docs/REFACTOR.md) · Archived plans: [MVP build](docs/history/BUILD_PLAN.md), [avatars, DMs, attachments](docs/history/NEXT_FEATURES_PLAN.md)

## Requirements

- Node.js ≥ 22 and npm ≥ 11
- Linux or macOS (x64/arm64) — `npm run setup` downloads the matching PocketBase binary
- For e2e tests: Playwright's Chromium (`npx playwright install chromium`)

## Getting started

```sh
npm ci
npm run setup      # downloads the pinned PocketBase (checksum-verified) into bin/
npm run dev        # esbuild watch + PocketBase on http://127.0.0.1:8090
```

Open http://127.0.0.1:8090 and sign up (top right). The dev database lives in `pb_data/` — delete it to start over.
The PocketBase admin UI is at http://127.0.0.1:8090/_/ (create a superuser with
`bin/pocketbase superuser upsert you@example.com <password> --dir=pb_data`).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Unminified watch build into `pb_public/` + `pocketbase serve --dev` |
| `npm run build` | Production build (hashed assets) into `pb_public/`; fails if over the size budget |
| `npm run typecheck` | `tsc` (strict) for the frontend, tests and scripts, plus `pb_hooks/` + `pb_migrations/` against PocketBase's generated types (`types/pocketbase.d.ts`, written by `scripts/pb-types.sh`) |
| `npm run lint` | Biome: formatting, lint rules, import order (`npm run format` applies the fixes) |
| `npm run lint:sinks` | Fails if frontend code uses `innerHTML` & co. (XSS guard) |
| `npm test` | Unit/view tests (Vitest + happy-dom) against a real, throwaway PocketBase |
| `npm run test:int` | Integration tests: schema, API rules, hooks, realtime, pagination |
| `npm run test:e2e` | Playwright end-to-end tests against the production build |
| `npm run schema:snapshot` | Rewrite `docs/schema.snapshot.json` (every collection's API rules, fields and indexes, and the rate limits) after a migration changes them; `test:int` fails while it is out of date |
| `npm run check` | typecheck + lint + lint:sinks + test + test:int + build (what CI runs before e2e) |

Every test run starts its own PocketBase on a free port with a temp data dir — there are no fakes and nothing to
clean up. CI (`.github/workflows/ci.yml`) runs typecheck, lint and build, then unit, integration and e2e side by side, e2e once
per browser (Chromium, Firefox, WebKit).

## Project layout

```
pb_migrations/   schema + API rules (the source of truth for access control)
pb_hooks/        server-side hooks: trimming, soft delete, edit/archive stamps, DM + unread routes, guards, security headers
web/src/         frontend: api.ts (only SDK user), router, store, views/, lib/ (pure logic)
web/styles/      app.css (bundles app/*.css, one file per part) and viewer.css
scripts/         build, dev, fetch-pocketbase, html-sink check
tests/           unit/, integration/, e2e/, support/ (PocketBase harness, helpers)
```

## Deploying

Build once, then copy `bin/pocketbase`, `pb_public/`, `pb_migrations/` and `pb_hooks/` to the server.
Migrations run automatically on start.

```sh
npm ci && npm run setup && npm run build
rsync -a bin/pocketbase pb_public pb_migrations pb_hooks server:/opt/chat/
```

With a domain pointing at the server, PocketBase serves HTTPS itself (Let's Encrypt):

```ini
# /etc/systemd/system/chat.service
[Unit]
Description=Chat (PocketBase)
After=network-online.target

[Service]
User=chat
WorkingDirectory=/opt/chat
ExecStart=/opt/chat/pocketbase serve chat.example.com --dir=/opt/chat/pb_data --publicDir=/opt/chat/pb_public --migrationsDir=/opt/chat/pb_migrations --hooksDir=/opt/chat/pb_hooks
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now chat
sudo -u chat /opt/chat/pocketbase superuser upsert you@example.com <password> --dir=/opt/chat/pb_data
```

Behind an existing reverse proxy instead, use `serve --http=127.0.0.1:8090` and proxy to it (keep
`/api/realtime` unbuffered — it is a Server-Sent Events stream), and start PocketBase with
`TRUSTED_PROXY=X-Forwarded-For` (`Environment=` in the unit). The rate limits are per client IP: without it, every
request seems to come from the proxy, and one client tripping a limit trips it for everyone. The rightmost address of
the header is used, the one your proxy added. The Docker image sets it (Dokku always runs a proxy in front); run it
with `-e TRUSTED_PROXY=off` if clients reach port 8090 directly, since they could then choose their own IP. Unset, the
setting is left as configured under *Settings → Application* in the admin UI.

**Branding and invite-only signups:** in the admin UI, *Collections → site*, edit the one record: `title` and `logo`
are shown in the app bar, on the login page and in the tab's title. Tick `invite_only` and fill `invite_code` to let
only people who have the code sign up (they enter it on the Sign up form; it is case-sensitive). Change the code to stop
the old one working; leave it empty to close signups. Existing accounts are unaffected, and you can still create
accounts yourself under *Collections → users*.

**Backups:** in the admin UI, *Settings → Backups* — schedule automatic backups (optionally to S3-compatible
storage). Uploaded files (avatars, attachments) live in `pb_data/storage` (or S3, under *Settings → Files storage*) and
are part of the backups, so plan disk space for them. **Rate limits** (per IP: messages 10 per 5 s, edits/deletes 20
per 10 s, reactions 30 per 10 s, forwarding and deleting several messages 20 requests per minute each, password changes 5 per minute, new rooms 5 per minute, opening DMs 10 per minute, signups 20 per minute; PocketBase defaults for the rest)
are set by the migrations and adjustable under *Settings → Rate limits*.
