// Link previews (§28), end to end against their own PocketBase (previews on) and a stub web site. The worker runs on a
// cron job and on POST /api/previews/tick; checks wait for its work with `eventually`, since either may do it.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import PocketBase, { type RecordModel } from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG, PNG_BASE64 } from "../support/files.ts";
import { uniq } from "../support/ids.ts";
import { withName } from "../support/names.ts";
import { disableRateLimits, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { sleep, status } from "./helpers.ts";

const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0]);

/** The stub site's pages: [content type, body]. */
const PAGES: Record<string, [string, string | Uint8Array]> = {
  "/og": [
    "text/html; charset=utf-8",
    `<html><head><title>Ignored</title><meta property="og:title" content="Tom &amp; Jerry&#39;s page"><link rel="shortcut icon" href="/i.png"></head></html>`,
  ],
  "/plain": ["text/html", "<html><head><title>\n  Plain   title\n</title></head><body>hi</body></html>"],
  "/latin1": ["text/html; charset=iso-8859-1", Uint8Array.from([...Buffer.from("<title>Caf"), 0xe9, ...Buffer.from("</title>")])],
  "/big-icon": ["text/html", `<title>Big icon</title><link rel="icon" href="big.png">`],
  "/untitled": ["text/html", "<p>no title</p>"],
  // Terminal colours, a bell, a right-to-left override, a tab: what a page's title can hold (QA BUG-110).
  "/junk": ["text/html", "<title>Bell&#7; esc&#27;[31m red &#x202E;desrever&#x202C; tab&#9;x\u200b</title>"],
  "/doc.pdf": ["application/pdf", "%PDF-1.4"],
  "/i.png": ["image/png", PNG],
  "/big.png": ["image/png", new Uint8Array(20 * 1024)],
  "/favicon.ico": ["application/octet-stream", ICO],
};

let site: Server;
let base = "";
/** Answered only after the worker's page timeout: a site that never answers. */
const NEVER_MS = 6_000;
/** Hosts the stub was asked for, as the Host header says, and the paths. */
const asked: string[] = [];
const paths: string[] = [];
let server: PocketBaseServer;
let admin: PocketBase;

beforeAll(async () => {
  site = createServer((req, res) => {
    asked.push(req.headers.host ?? "");
    paths.push(req.url ?? "");
    if (req.url?.startsWith("/never")) {
      setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end("<title>Late</title>"), NEVER_MS);
      return;
    }
    const page = PAGES[(req.url ?? "/").split("?")[0]!];
    if (!page) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": page[0] }).end(page[1]);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const { port } = site.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  server = await startPocketBase({ fixtureRoute: true, env: { LINK_PREVIEWS: "on", LINK_PREVIEWS_ALLOW_HOSTS: `127.0.0.1:${port}` } });
  await disableRateLimits(server.url);
  admin = new PocketBase(server.url);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
}, 60_000);

afterAll(async () => {
  await server?.stop();
  site?.closeAllConnections();
  await new Promise((r) => site?.close(r));
});

const tick = () => admin.send("/api/previews/tick", { method: "POST" }).catch(() => {});

/** Wait (up to `ms`) until `fn` passes, running the worker meanwhile. */
async function eventually<T>(fn: () => T | Promise<T>, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await tick();
      await sleep(100);
    }
  }
}

interface User {
  pb: PocketBase;
  user: RecordModel;
}

async function signUp(name = `user-${uniq()}`): Promise<User> {
  const pb = new PocketBase(server.url);
  pb.autoCancellation(false);
  const email = `${uniq()}@test.local`;
  const password = "password-123";
  await withName(server.url, name, () => pb.collection("users").create({ email, password, passwordConfirm: password, name }));
  const { record } = await pb.collection("users").authWithPassword(email, password);
  return { pb, user: record };
}

async function roomOf(owner: User) {
  return owner.pb.collection("rooms").create({ name: `lp-${uniq()}`, created_by: owner.user.id });
}

const send = (u: User, room: string, text: string) => u.pb.collection("messages").create({ room, author: u.user.id, text });
const previewsOf = async (u: User, id: string) => (await u.pb.collection("messages").getOne(id)).previews as unknown[];

describe("link previews", () => {
  it("a line per link: title (og:title first) and favicon, each link once", async () => {
    const me = await signUp();
    const room = await roomOf(me);
    const text = `see ${base}/og, ${base}/plain and (${base}/og) ${base}/latin1 ${base}/big-icon ${base}/untitled`;
    const m = await send(me, room.id, text);
    const previews = await eventually(async () => {
      const p = await previewsOf(me, m.id);
      expect(p).toHaveLength(4);
      return p;
    });
    expect(previews).toEqual([
      { url: `${base}/og`, title: "Tom & Jerry's page", icon: `data:image/png;base64,${PNG_BASE64}` },
      { url: `${base}/plain`, title: "Plain title", icon: `data:image/x-icon;base64,${Buffer.from(ICO).toString("base64")}` },
      { url: `${base}/latin1`, title: "Café", icon: expect.stringMatching(/^data:image\/x-icon;base64,/) },
      // The icon it names is too big to keep: the site's /favicon.ico instead.
      { url: `${base}/big-icon`, title: "Big icon", icon: expect.stringMatching(/^data:image\/x-icon;base64,/) },
    ]);
  });

  it("none for a page without a title or what isn't a page, nor past the 5th link", async () => {
    const me = await signUp();
    const room = await roomOf(me);
    const tag = uniq();
    const links = [`/untitled?${tag}`, ...[1, 2, 3, 4].map((n) => `/doc.pdf?${tag}-${n}`)];
    const m = await send(me, room.id, `${links.map((l) => base + l).join(" ")} ${base}/og?${tag}`);
    await eventually(() => expect(paths).toEqual(expect.arrayContaining(links)));
    await tick(); // done with the message, whichever worker took it
    expect(await previewsOf(me, m.id)).toEqual([]);
    expect(paths).not.toContain(`/og?${tag}`);
  });

  it("clients can't set previews, on create or on update", async () => {
    const me = await signUp();
    const room = await roomOf(me);
    const fake = [{ url: "https://evil.example", title: "Bank", icon: "" }];
    expect(await status(me.pb.collection("messages").create({ room: room.id, author: me.user.id, text: "x", previews: fake }))).toBe(400);
    const m = await send(me, room.id, "x");
    expect(await status(me.pb.collection("messages").update(m.id, { previews: fake }))).toBe(404); // the update rule
    expect(await previewsOf(me, m.id)).toEqual([]);
  });

  it("an edit replaces them with the new text's; deleting the message clears them", async () => {
    const me = await signUp();
    const room = await roomOf(me);
    const m = await send(me, room.id, `${base}/og`);
    await eventually(async () => expect(await previewsOf(me, m.id)).toHaveLength(1));
    const edited = await me.pb.collection("messages").update(m.id, { text: "no links now" });
    expect(edited.previews).toEqual([]);
    await me.pb.collection("messages").update(m.id, { text: `now ${base}/plain` });
    await eventually(async () => expect(await previewsOf(me, m.id)).toMatchObject([{ title: "Plain title" }]));
    await me.pb.collection("messages").update(m.id, { deleted: true });
    expect(await previewsOf(me, m.id)).toEqual([]);
  });

  it("a forward shows its original's previews", async () => {
    const me = await signUp();
    const room = await roomOf(me);
    const other = await roomOf(me);
    const m = await send(me, room.id, `${base}/og`);
    await eventually(async () => expect(await previewsOf(me, m.id)).toHaveLength(1));
    const [fwd] = await me.pb.send("/api/chat/forward", { method: "POST", body: { messages: [m.id], room: other.id } });
    expect(await previewsOf(me, fwd.id)).toMatchObject([{ title: "Tom & Jerry's page" }]);
  });

  it("a title keeps no control or bidi characters (QA BUG-110)", async () => {
    const me = await signUp();
    const room = await roomOf(me);
    const m = await send(me, room.id, `${base}/junk`);
    const [p] = await eventually(async () => {
      const p = await previewsOf(me, m.id);
      expect(p).toHaveLength(1);
      return p as { title: string }[];
    });
    expect(p!.title).toBe("Bell esc [31m red desrever tab x");
  });

  it("a site that never answers costs one timeout, and doesn't hold up the next message (QA BUG-111)", async () => {
    const me = await signUp();
    const room = await roomOf(me);
    const tag = uniq();
    await send(me, room.id, [1, 2, 3, 4, 5].map((n) => `${base}/never?${tag}-${n}`).join(" "));
    const next = await send(me, room.id, `${base}/plain?${tag}`);
    // Five timeouts in a row (4 s each) held it up for 20 s; now the first one tells the worker to stop asking.
    await eventually(async () => expect(await previewsOf(me, next.id)).toMatchObject([{ title: "Plain title" }]), 12_000);
    expect(paths.filter((p) => p.startsWith(`/never?${tag}`)).length).toBeLessThanOrEqual(2); // the cron's worker may take it too
  });

  it("never fetches local or private addresses", async () => {
    const me = await signUp();
    const room = await roomOf(me);
    const port = base.split(":").at(-1);
    asked.length = 0;
    const local = [`http://localhost:${port}/og`, `http://127.0.0.2:${port}/og`, "http://169.254.169.254/latest", "http://db/og"];
    const m = await send(me, room.id, `${local.join(" ")} ${base}/plain`);
    await eventually(async () => expect(await previewsOf(me, m.id)).toMatchObject([{ title: "Plain title" }]));
    expect(asked.every((h) => h === base.slice("http://".length))).toBe(true);
  });
});
