// A real disconnect: this spec runs its own PocketBase (own port + data dir, so other specs are unaffected),
// stops it to kill the realtime stream, writes messages while it is down, then restarts it. The client must
// reconnect on its own and fill the gap by fetching pages — the messages were never sent as live events.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { disableRateLimits, type PocketBaseServer, startPocketBase } from "../support/pocketbase.ts";
import { apiRoom, apiUser, messages, openRoom, seed } from "./fixtures.ts";

const freePort = () =>
  new Promise<number>((ok) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => ok(port));
    });
  });

test("after a dropped connection, everything missed appears in order once it reconnects", async ({ browser }) => {
  test.setTimeout(90_000);
  const tmp = await mkdtemp(join(tmpdir(), "chat-e2e-reconnect-"));
  const dataDir = join(tmp, "pb_data");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    const pb = await startPocketBase({ port, dataDir, publicDir: resolve("pb_public"), fixtureRoute: true });
    await disableRateLimits(pb.url);
    return pb;
  };
  let server: PocketBaseServer | null = await start();
  try {
    const ada = await apiUser("Ada", base);
    const bob = await apiUser("Bob", base);
    const room = await apiRoom(ada, undefined, base);
    seed(room, ada, 10, { dataDir, text: (i) => `before ${i + 1}` });
    const b = await openRoom(browser, bob, room, base);
    await expect(messages(b)).toHaveCount(10);

    await server.stop(); // the SSE stream drops for real
    server = null;
    const missed = seed(room, ada, 80, { dataDir, startAt: Date.now(), stepMs: 10, text: (i) => `while down ${i + 1}` });

    const pageFetches: string[] = [];
    b.on("request", (r) => r.url().includes("/api/collections/messages/records") && pageFetches.push(r.url()));
    server = await start();

    await expect(messages(b).last().locator(".body")).toHaveText("while down 80", { timeout: 30_000 });
    const texts = await messages(b).locator(".body").allTextContents();
    expect(texts.slice(-80)).toEqual(missed);
    expect(new Set(texts).size).toBe(texts.length);
    expect(pageFetches.length).toBeGreaterThanOrEqual(2); // 50 + 30: filled by paging, not live events
    await b.context().close();
  } finally {
    await server?.stop();
    await rm(tmp, { recursive: true, force: true });
  }
});
