// Server load test (docs/PERF.md): a throwaway server (as the tests start one) with a busy room, then timings of what
// clients do most, and what each costs the server in CPU time.
//
//   node --no-warnings scripts/bench.ts [--out=before.json] [--clients=20] [--idle=60] [--workers=off] [--subs=both|room|activity]
//
// Phases: room pages (one client after another, then 8 at once), realtime (every client subscribed to the room as
// the web is; a message sent, timed until every client has it) and idle (nothing asked of the server for --idle
// seconds, the background workers on). CPU is the server process's own (utime + stime), so the client's work here
// doesn't count. --out keeps the numbers as JSON, to compare a change against the run before it.

import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import "../tests/support/eventsource.ts";
import { disableRateLimits, startPocketBase } from "../tests/support/pocketbase.ts";
import { type Api, createApi } from "../web/src/api.ts";
import { latest, older } from "../web/src/lib/cursor.ts";
import { newId } from "../web/src/lib/id.ts";
import type { Message } from "../web/src/lib/types.ts";
import { createClient } from "../web/src/pb.ts";

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const CLIENTS = Number(arg("clients", "20"));
const IDLE_S = Number(arg("idle", "60"));
const WORKERS = arg("workers", "on");
const OUT = arg("out", "");
const SUBS = arg("subs", "both"); // which of the web's two message subscriptions each client makes
const MESSAGES = 300;
const PAGES = 200;
const SENDS = 40;
const EMOJI = ["👍", "❤️", "😂", "🎉"];

const TICK_MS = 10; // USER_HZ is 100 on Linux

/** The server process listening on `port`. */
function serverPid(port: string): number {
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/cmdline`, "utf8").includes(`--http=127.0.0.1:${port}`)) return Number(d);
    } catch {}
  }
  throw new Error(`no server on ${port}`);
}

/** CPU time the process has used, in ms. */
function cpuMs(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(f[11]) + Number(f[12])) * TICK_MS;
}

function rssMb(pid: number): number {
  const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
  return Math.round(Number(kb) / 1024);
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))]!;
const round = (x: number) => Math.round(x * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pb = await startPocketBase({
  fixtureRoute: true,
  // The workers on, as in production (tests turn them off); no page has a link, so previews fetch nothing.
  env: { MEDIA_CRON: WORKERS, LINK_PREVIEWS: WORKERS },
});
const results: Record<string, number> = {};
try {
  await disableRateLimits(pb.url);
  const pid = serverPid(new URL(pb.url).port);

  // ---- a room as busy rooms are: replies, reactions, forwards
  const apis: Api[] = [];
  for (let i = 0; i < CLIENTS; i++) {
    const api = createApi(createClient(pb.url));
    await api.signUp({ email: `bench${i}@example.com`, password: "password-123", name: `Bench ${i}` });
    apis.push(api);
  }
  const room = await apis[0]!.createRoom("busy", "public");
  const elsewhere = await apis[0]!.createRoom("elsewhere", "public");
  const origin = await apis[0]!.send({ id: newId(), room: elsewhere.id, text: "forwarded from elsewhere" });
  const ids: string[] = [];
  for (let i = 0; i < MESSAGES; i++) {
    const by = apis[i % CLIENTS]!;
    if (i % 10 === 9) {
      const [m] = await by.forward([origin.id], room.id);
      ids.push(m!.id);
      continue;
    }
    const id = newId();
    const replyTo = i % 5 === 4 && ids.length ? ids[ids.length - 3] : undefined;
    await by.send({ id, room: room.id, text: `message ${i} of the bench`, ...(replyTo ? { replyTo } : {}) });
    ids.push(id);
    if (i % 5 < 3) for (let k = 0; k < 1 + (i % 3); k++) await apis[(i + k + 1) % CLIENTS]!.react(id, EMOJI[k]!, true);
  }
  results.rssAfterSeedMb = rssMb(pid);

  // ---- room pages: latest, then older ones, as a room opens and scrolls back
  const reader = apis[1]!;
  // The cursors of the first three pages back.
  const cursors: { created: string; id: string }[] = [];
  let page = await reader.page(latest(room.id));
  for (let i = 0; i < 3; i++) {
    const last = page[page.length - 1]!;
    cursors.push({ created: last.created, id: last.id });
    page = await reader.page(older(room.id, cursors[i]!));
  }
  const pageQuery = (n: number) => (n % 4 === 0 ? latest(room.id) : older(room.id, cursors[(n % 4) - 1]!));
  // Warm up: hooks pool, SQLite page cache.
  for (let i = 0; i < 20; i++) await reader.page(latest(room.id));
  const one: number[] = [];
  let cpu = cpuMs(pid);
  for (let i = 0; i < PAGES; i++) {
    const t = performance.now();
    const got: Message[] = await reader.page(pageQuery(i));
    one.push(performance.now() - t);
    if (got.length !== 50) throw new Error(`a page of ${got.length}`);
  }
  results.pageMsP50 = round(pct(one, 50));
  results.pageMsP95 = round(pct(one, 95));
  results.pageCpuMs = round((cpuMs(pid) - cpu) / PAGES);

  const many: number[] = [];
  cpu = cpuMs(pid);
  let t0 = performance.now();
  await Promise.all(
    Array.from({ length: 8 }, async (_, w) => {
      for (let i = w; i < PAGES; i += 8) {
        const t = performance.now();
        await apis[w + 1]!.page(pageQuery(i));
        many.push(performance.now() - t);
      }
    }),
  );
  results.pages8MsP50 = round(pct(many, 50));
  results.pages8MsP95 = round(pct(many, 95));
  results.pages8PerS = round(PAGES / ((performance.now() - t0) / 1000));
  results.pages8CpuMs = round((cpuMs(pid) - cpu) / PAGES);

  // ---- realtime: every client in the room, as the web subscribes (the room's messages, and all activity)
  const seen = new Map<string, number>();
  const arrived = new Map<string, number>();
  await Promise.all(
    apis.map(async (api) => {
      const on = (_: string, m: { id: string }) => {
        const n = (seen.get(m.id) ?? 0) + 1;
        seen.set(m.id, n);
        if (n === CLIENTS) arrived.set(m.id, performance.now());
      };
      if (SUBS !== "activity") await api.subscribeMessages(room.id, on);
      if (SUBS !== "room") await api.subscribeAllMessages(SUBS === "activity" ? on : () => {});
    }),
  );
  await sleep(500);
  const fanout: number[] = [];
  cpu = cpuMs(pid);
  for (let i = 0; i < SENDS; i++) {
    const id = newId();
    const replyTo = ids[MESSAGES - 1 - i];
    t0 = performance.now();
    await apis[i % CLIENTS]!.send({ id, room: room.id, text: `live ${i}`, ...(i % 2 ? { replyTo } : {}) });
    while (!arrived.has(id)) {
      if (performance.now() - t0 > 10_000) throw new Error(`message ${i} never reached every client`);
      await sleep(2);
    }
    fanout.push(arrived.get(id)! - t0);
  }
  results.fanoutMsP50 = round(pct(fanout, 50));
  results.fanoutMsP95 = round(pct(fanout, 95));
  results.fanoutCpuMsPerMsg = round((cpuMs(pid) - cpu) / SENDS);
  for (const api of apis) await api.unsubscribeAll();

  // ---- idle: only the workers
  await sleep(2000);
  cpu = cpuMs(pid);
  await sleep(IDLE_S * 1000);
  results.idleCpuMsPerMin = round(((cpuMs(pid) - cpu) * 60) / IDLE_S);
  results.rssEndMb = rssMb(pid);
} finally {
  await pb.stop();
}

const width = Math.max(...Object.keys(results).map((k) => k.length));
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(width)}  ${v}`);
if (OUT) await writeFile(OUT, `${JSON.stringify(results, null, 2)}\n`);
