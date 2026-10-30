# Performance

How fast the product is and what it costs to run, measured, and what was changed for it. The web client's own
budgets (bundle size, room switching) are in DESIGN.md and checked by the build; the Android app's are in ANDROID.md
§11.

## 1. The server load test

`scripts/bench.ts` starts a throwaway server (as the tests do, with the background workers on), fills a room the way
busy rooms are (300 messages from 20 people: every fifth a reply, every tenth a forward, three in five with
reactions) and measures what clients do most, with the CPU time each costs the server process (not the client):

```sh
node --no-warnings scripts/bench.ts [--out=run.json] [--clients=20] [--idle=60] [--workers=off] [--subs=both|room|activity]
```

| Number | What |
|---|---|
| `pageMs…`, `pageCpuMs` | A room page (50 messages, the web's `expand` and `fields`), one after another: latest and three pages back |
| `pages8…` | The same, 8 clients at once (a room opening on many devices, prefetching), and pages a second |
| `fanout…` | A message sent until all 20 clients, each subscribed as the web is (the room, and all activity), have it |
| `--subs` | Which of the two subscriptions each client makes in the `fanout` phase (to tell their costs apart) |
| `idleCpuMsPerMin` | Nothing asked for `--idle` seconds: the workers, and PocketBase itself |
| `rss…Mb` | The server's memory after seeding and at the end |

Numbers vary by about ±10% between runs; compare runs on the same machine, at the same time (the development machine
is shared: its numbers move by a third from one hour to the next). `--idle=1` skips most of the idle phase. At least 9
clients (the 8 at once, and the reader).

## 2. 2026-10-30: room pages and idle workers

On the development machine (8 threads):

| | Before | After |
|---|---|---|
| Room page, p50 / p95 | 36 / 57 ms | 20 / 29 ms |
| Server CPU per page | 51 ms | 33 ms |
| 8 clients at once: pages a second | 32 | 61–65 |
| 8 clients at once: p50 / p95 | 249 / 331 ms | 122 / 176 ms |
| 8 clients at once: server CPU per page | 165 ms | 101 ms |
| A message to 20 clients, p50 / p95 | 87 / 123 ms | 69 / 97 ms |
| Idle, CPU a minute (PocketBase alone: 45) | 120 ms | 65 ms |

### 2.1 The messages enrich hook

Every message the API answers with goes through a JS hook (`onRecordEnrich`, main.pb.js). Taken apart:

| 8 clients at once | Pages a second | CPU per page |
|---|---|---|
| The hook as it was | 32 | 165 ms |
| The hook doing nothing | 62 | 86 ms |
| No hook at all | 121 | 40 ms |

The hook's work was a query per message: `keepToRoom` read the message's room for every reply or message with
reactions (the same room each time, which the route had already checked), `showOriginal` the original of every
forward. And under load PocketBase runs a hook call beyond `--hooksPool` in a JS runtime made for that one call, which
loads `lib/messages.js` and everything it requires from scratch.

- The list routes (`lib/lists.js`: room pages, the notification check) mark the rooms they checked while they enrich
  (`lib/enrich.js markChecked`); the hook leaves those rooms' messages alone, and the route shows the forwards'
  originals itself in one query (`lib/messages.js showOriginals`), for expanded replies too. The hooks see a copy of
  the request's info, but its query map is shared, so the mark is a query parameter whose value starts with a secret
  of the process (a client can't forge it). Messages from other rooms (`?expand=forward_of`) still go through the
  hook. The records API and realtime are as before.
- The hook asks `lib/enrich.js` (no requires) whether a message needs anything before it loads `lib/messages.js`:
  most need nothing.

What is left is the cost of having a JS hook at all (62 vs 121 pages a second). A larger pool buys some of it back
with memory: `--hooksPool=500` gave 68 pages a second for 250 MB more, so it stays at 100.

### 2.2 The workers

The media and link previews workers (`lib/worker.js`) looked for work every second all day: a few indexed queries
each, about 75 ms of CPU a minute together. They now say `wakes`: idle, a run looks only when a save wakes it
(`wake`, from after-commit hooks: a message with files, a collection item, a link queued) and every 30 s for work
queued some other way. A new upload's thumbnails and a link's preview still start within a second. The federation
worker (off unless linked) and the Telegram bridge (it long-polls Telegram) are as they were.

### 2.3 Live messages (2026-10-30, later)

A message sent costs the server work for every client in the room. Taken apart (CPU per message, 20 clients, half the
messages replies; all measured side by side in one session, when the machine was busier than in the table above):

| What each client subscribes to | CPU per message |
|---|---|
| The room and all activity (the web, the app) | 144 ms |
| The room only | 127 ms |
| All activity only (`fields`, no `expand`) | 42 ms |
| The room only, the enrich hook not registered | 92 ms |
| The same, without `reply_to` in the expand | 43 ms |

- **The quote of a reply** (`expand=reply_to.author`) cost the server about 5 ms a client for every reply: PocketBase
  checks the messages view rule and expands it per client, and its SQL is only 0.5 ms of that. Live events now come
  without it (`LIVE_OPTS` in `api.ts` and `ChirkleApi.kt`): the room takes the quote from the message in its window,
  or from its own copy of the reply (an edit); a reply to a message beyond the window fetches that one message. Pages,
  `getMessage` and `send` still expand it.
- **The JS enrich hook** costs ~35 ms a message even when it does nothing (~0.6 ms a call). It stays: it keeps
  another room's replies and reactions out of a forward's original, which a `messages/{id}` subscription could
  otherwise read.
- **Merging the two subscriptions** would save only ~17 ms: not done.

| A message to 20 clients (same session) | Before | After |
|---|---|---|
| p50 / p95 | 101–108 / 160–179 ms | 61–63 / 79–91 ms |
| Server CPU | 144–147 ms | 87–88 ms (−39%) |

Apps from before this still ask for the quote, and cost what they did.

### 2.4 Quiet connections (2026-10-30, later)

An open web tab left alone, measured for 5–7 minutes (headless Chromium, a room open): nothing but a file token
every 2 minutes (attachment URLs, §17.3), and then, 5 minutes after it connected, a realtime reconnect followed by the
room list, hidden rooms, unread counts, collections and the open room's pages again. PocketBase closes a realtime
connection that has sent nothing for 5 minutes, and both clients take every reconnect for one that may have missed
events. Every quiet client did this every 5 minutes, the app in the foreground too.

`lib/keepalive.js` sends every connected client a `chat/keepalive` event every 3 minutes (cron). Clients have no
listener for it and drop it, old apps included. Over 7 minutes the tab then made only its three file token requests.
`POST /api/keepalive/tick` (superusers) runs it at once, for tests.

## 3. The Android app

The release build is what to judge: debug builds of Compose are many times slower. On the KVM-less emulator here
everything is slow; numbers from it only compare runs with each other.

`android/baselineprofile` (ANDROID.md §33) generates the Baseline Profile (start, the room list, opening a room,
scrolling) and benchmarks start and scrolling with and without it. The profile is in the app since 2026-10-30:

| On the emulator here (TCG, no KVM) | Nothing compiled | With the profile |
|---|---|---|
| Cold start, first frame (median of 5) | 11.7 s | 11.8 s |
| Cold start, room list shown (`reportFullyDrawn`) | 47.2 s | 37.8 s (−20%) |
| Opening the busy room and scrolling: CPU per frame p50 / p90 | 402 / 1,253 ms | 264 / 771 ms (−34% / −38%) |
| The same, p95 / p99 | 1,792 / 5,347 ms | 1,069 / 3,047 ms (−40% / −43%) |

The emulator is many times slower than a phone, so only the differences mean anything: the profile takes about a
fifth off showing the room list and over a third off the room's frames. The first frame doesn't move (on this
emulator it is mostly the process starting).
