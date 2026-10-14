// The service worker (DESIGN.md §27): the app opens offline and can be installed. Built on its own to /sw.js (it must
// sit at the root to control every page); app.js imports nothing from it.
//
// - Pages: network first, so a deploy shows on the next load; offline, the last page loaded (index.html: every page
//   of the app is the same shell, §7.1).
// - Content-hashed assets (/assets/*-HASH.js|css): cache first; they never change under one name.
// - Everything else, the API and realtime included, is left to the browser: no stale data, no cached files.

// Only what this file uses: the "dom" lib has no service worker types, and "webworker" conflicts with it.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Promise<Response>): void;
}
interface Scope {
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}

export {}; // a module: these types stay out of the global scope

const sw = self as unknown as Scope;

const CACHE = "chat-shell";
/** The key the last page is kept under. */
const SHELL = "/";
/** esbuild's "[name]-[hash]" names; the server caches these for a year too (§5.6). Dev builds are unhashed. */
const HASHED = /^\/assets\/.+-[A-Z0-9]{8}\.(js|css)$/;

// A new worker takes over at once: it holds no state an old page depends on.
sw.addEventListener("install", (e) => e.waitUntil(sw.skipWaiting()));
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // Files (opened in a tab) and the admin UI are not the app's pages.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_/")) return;
  if (req.mode === "navigate") e.respondWith(page(e));
  else if (HASHED.test(url.pathname)) e.respondWith(asset(req));
});

/** @returns the page from the network, kept for offline; offline, the last one kept */
async function page(e: FetchEvent): Promise<Response> {
  try {
    const res = await fetch(e.request);
    if (res.ok && res.headers.get("content-type")?.startsWith("text/html")) e.waitUntil(keep(res.clone()));
    return res;
  } catch (err) {
    const kept = await caches.match(SHELL, { cacheName: CACHE });
    if (kept) return kept;
    throw err;
  }
}

/** Keep the page, and drop the assets of older builds: those it doesn't name (a lazy chunk comes back when used). */
async function keep(res: Response) {
  const cache = await caches.open(CACHE);
  const html = await res.clone().text();
  await cache.put(SHELL, res);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path !== SHELL && !html.includes(path)) await cache.delete(req);
  }
}

/** @returns the cached asset, else the network's (kept when it is a success) */
async function asset(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}
