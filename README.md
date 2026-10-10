# Chat

A small, fast, real-time group chat. One [PocketBase](https://pocketbase.io) binary is the whole backend
(auth, data, realtime, static files); the frontend is vanilla TypeScript bundled by esbuild — no framework,
~21 KB of JS gzipped.

- Public rooms anyone can create; hide rooms you don't care about; creators archive rooms (read-only, history kept)
- Live messages, edits and deletes (deleted messages leave a placeholder)
- Full history: scroll back to the very first message of any room (windowed, ≤300 messages in the DOM)
- Optimistic sending with safe retries, reconnect gap-fill, light/dark themes, works on phones

Design: [`docs/DESIGN.md`](docs/DESIGN.md) · Build plan & status: [`docs/TODO.md`](docs/TODO.md)

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

Open http://127.0.0.1:8090 and sign up. The dev database lives in `pb_data/` — delete it to start over.
The PocketBase admin UI is at http://127.0.0.1:8090/_/ (create a superuser with
`bin/pocketbase superuser upsert you@example.com <password> --dir=pb_data`).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Unminified watch build into `pb_public/` + `pocketbase serve --dev` |
| `npm run build` | Production build (hashed assets) into `pb_public/`; fails if over the size budget |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint:sinks` | Fails if frontend code uses `innerHTML` & co. (XSS guard) |
| `npm test` | Unit/view tests (Vitest + happy-dom) against a real, throwaway PocketBase |
| `npm run test:int` | Integration tests: schema, API rules, hooks, realtime, pagination |
| `npm run test:e2e` | Playwright end-to-end tests against the production build |
| `npm run check` | typecheck + lint:sinks + test + test:int + build (what CI runs before e2e) |

Every test run starts its own PocketBase on a free port with a temp data dir — there are no fakes and nothing to
clean up. CI (`.github/workflows/ci.yml`) runs `check`, then e2e on Chromium, Firefox and WebKit.

## Project layout

```
pb_migrations/   schema + API rules (the source of truth for access control)
pb_hooks/        server-side hooks: trimming, soft delete, edit/archive stamps, security headers
web/src/         frontend: api.ts (only SDK user), router, store, views/, lib/ (pure logic)
web/styles/      the one stylesheet
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
`/api/realtime` unbuffered — it is a Server-Sent Events stream).

**Backups:** in the admin UI, *Settings → Backups* — schedule automatic backups (optionally to S3-compatible
storage). **Rate limits** (messages: 10 per 5 s per IP; signups: 20 per minute; PocketBase defaults for the rest)
are set by the init migration and adjustable under *Settings → Rate limits*.
