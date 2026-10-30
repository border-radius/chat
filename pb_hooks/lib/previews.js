/// <reference path="../../types/pocketbase.d.ts" />
// Link previews (DESIGN.md §28): under a message, a line for each link in it, the page's favicon and title. A new
// message, or an edit of the text, queues it (link_queue, in the save's transaction); a worker started by a cron job
// fetches the pages and saves `previews` on the message, which reaches everyone live as an update. Off with
// LINK_PREVIEWS=off.
//
// The server fetches what anyone links to, so it only goes to public web addresses (lib/outbound.js says which); curl
// then connects to the address checked and no other, so a name that answers differently the second time can't send it
// inward. Redirects are followed here, not by curl, each checked the same way. The pages are read by lib/pages.js.
//
// curl, not $http.send: that follows redirects anywhere and reads a whole response into memory, however big (a page
// ignoring Range took 1.1 GB). Of a response only the start is read, from curl's output; then curl is stopped.

const { addressOf, allowedHosts, parse, publicHost, resolve } = require(`${__hooks}/lib/outbound.js`);
const { attrs, base64, clean, decode, imageType, pageText, tags, titleOf } = require(`${__hooks}/lib/pages.js`);

/** Links looked at in one message. */
const MAX_LINKS = 5;
/** Of a page, only the start is read for its title and icon: the rest is never asked for (Range), nor read. */
const PAGE_BYTES = 256 * 1024;
/** A bigger icon is left out: it is kept in the message, as a data: URL. */
const MAX_ICON = 16 * 1024;
/** Seconds for a page, or an icon, redirects included. */
const PAGE_TIMEOUT = 4;
const ICON_TIMEOUT = 3;
const MAX_REDIRECTS = 3;
/**
 * A message's links are looked at for this long (ms) at most: links after it get no line. A message linking to sites
 * that never answer would otherwise hold up everyone's previews behind it, for minutes.
 */
const MESSAGE_MS = 12_000;
const UA = "Mozilla/5.0 (compatible; ChirkleLinkPreview/1.0)";

const LOCK = "previews.worker";
/** A lock not renewed for this long (ms) is a worker that died. Renewed after every message, which takes under 30 s. */
const STALE_MS = 120_000;
const BATCH = 10;

const enabled = () => $os.getenv("LINK_PREVIEWS").trim().toLowerCase() !== "off";

// ---------------------------------------------------------------- links (as web/src/lib/links.ts finds them)

const CANDIDATE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const TRAILING = /[.,:;!?'"*_…。“”‘’«»„‟‹›]$/;
/** @type {Record<string, string>} */
const OPENING = { ")": "(", "]": "[" };
/** @param {string} s @param {string} ch */
const count = (s, ch) => s.split(ch).length - 1;

/**
 * The http(s) links in `text` (www. ones as https), each once, at most MAX_LINKS.
 * @param {string} text
 * @returns {string[]}
 */
function linksOf(text) {
  /** @type {string[]} */
  const out = [];
  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(text); m && out.length < MAX_LINKS; m = CANDIDATE.exec(text)) {
    let url = m[0];
    for (;;) {
      const last = url.slice(-1);
      const open = OPENING[last];
      if (!TRAILING.test(last) && !(open && count(url, open) < count(url, last))) break;
      url = url.slice(0, -1);
    }
    const www = /^www\./i.test(url);
    if (www && /[@.-]/.test(text[m.index - 1] || "")) continue;
    const href = www ? `https://${url}` : url;
    if (parse(href) && !out.includes(href)) out.push(href);
  }
  return out;
}

// ---------------------------------------------------------------- fetching

/** Are curl, getent and timeout there? Looked up once: without them, links get no previews. */
function tools(/** @type {core.App} */ app) {
  return /** @type {boolean} */ (
    app.store().getOrSet("previews.tools", () => {
      try {
        $os.cmd("sh", "-c", "command -v curl && command -v getent && command -v timeout").output();
        return true;
      } catch {
        app.logger().warn("previews: no curl, getent or timeout, links get no previews");
        return false;
      }
    })
  );
}

/**
 * @typedef {{ status: number, headers: Record<string, string>, body: any, url?: string }} Response `headers` by
 * lowercased name (the first of each); `body` the start of it, as bytes; `url` where it came from, after redirects.
 */

/**
 * One GET with curl, connecting to `ip` ("": as curl looks the host up, for allowed
 * hosts), reading at most `max` bytes of the body. Throws when there is no response (a timeout, a refused connection).
 * @param {{ origin: string, path: string, scheme: string }} u
 * @param {string} ip
 * @param {Record<string, string>} headers
 * @param {number} seconds
 * @param {number} max
 * @returns {Response}
 */
function request(u, ip, headers, seconds, max) {
  const head = `${$os.tempDir()}/chirkle-preview-${$security.randomString(16)}`;
  // No ~/.curlrc, no proxy (it would look the host up itself), no globbing of [] and {} in the URL; no redirects (get
  // checks each). The headers go to a file, written as they come: there even when curl is stopped mid-body.
  const args = ["-q", "--silent", "--globoff", "--noproxy", "*", "--proto", "=http,https", "--max-time", seconds.toFixed(1)];
  // Whatever host curl makes of the URL, it connects here.
  if (ip) args.push("--connect-to", `::${ip}:${u.scheme === "https" ? 443 : 80}`);
  args.push("--user-agent", UA);
  for (const [k, v] of Object.entries(headers)) args.push("--header", `${k}: ${v}`);
  args.push("--dump-header", head, "--output", "-", "--url", u.origin + u.path);
  try {
    const cmd = $os.cmd("curl", ...args);
    const out = cmd.stdoutPipe();
    cmd.start();
    let body;
    try {
      body = toBytes(out, max);
    } finally {
      // The rest of a big body is never read: curl stops at the next write.
      try {
        cmd.process?.kill();
      } catch {
        // done already
      }
      try {
        cmd.wait();
      } catch {
        // killed, or failed: the headers tell
      }
    }
    let status = 0;
    /** @type {Record<string, string>} */
    let fields = Object.create(null);
    for (const line of toString($os.readFile(head)).split(/\r?\n/)) {
      const s = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line);
      if (s) {
        status = Number(s[1]);
        fields = Object.create(null);
        continue;
      }
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim().toLowerCase();
      if (colon > 0 && !(name in fields)) fields[name] = line.slice(colon + 1).trim();
    }
    if (!status) throw new Error("no response");
    return { status, headers: fields, body };
  } finally {
    try {
      $os.remove(head);
    } catch {
      // never written: no response
    }
  }
}

const REDIRECT = [301, 302, 303, 307, 308];

/**
 * GET `url` (following up to MAX_REDIRECTS redirects, each checked like the link), null on any failure or a final
 * status other than 200/206. A host that didn't answer (a timeout, a refused connection, a failed lookup) goes in
 * `dead` and isn't asked again for this message: its links to a site that never answers cost one timeout, not one
 * each.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeout seconds, for all of it
 * @param {number} max body bytes read
 * @param {Set<string>} dead
 */
function get(url, headers, timeout, max, dead) {
  const until = Date.now() + timeout * 1000;
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = parse(at);
    const left = (until - Date.now()) / 1000;
    if (!u || !publicHost(u.host) || dead.has(u.host) || left < 0.1) return null;
    /** @type {Response} */
    let res;
    try {
      let ip = "";
      if (!allowedHosts().includes(u.host)) {
        ip = addressOf(u.host);
        if (!ip) return null;
      }
      res = request(u, ip, headers, left, max);
    } catch {
      dead.add(u.host);
      return null;
    }
    if (res.status === 200 || res.status === 206) return { ...res, url: at };
    if (!REDIRECT.includes(res.status) || !res.headers.location) return null;
    at = resolve(res.headers.location, at);
  }
  return null;
}

/**
 * An icon as a data: URL, or "".
 * @param {string} url
 * @param {Set<string>} dead
 */
function icon(url, dead) {
  // One byte more than kept: a bigger icon shows by its length, and no more of it is read.
  const res = url ? get(url, { Accept: "image/*" }, ICON_TIMEOUT, MAX_ICON + 1, dead) : null;
  const b = res?.body;
  if (!b?.length || b.length > MAX_ICON) return "";
  const type = imageType(/** @type {Response} */ (res), b);
  return type ? `data:${type};base64,${base64(b)}` : "";
}

/**
 * What a link shows: the page's title (og:title, else <title>) and its icon. null when there is no title to show.
 * @param {string} url
 * @param {Set<string>} dead
 * @returns {{ url: string, title: string, icon: string } | null}
 */
function preview(url, dead) {
  const accept = { Accept: "text/html,application/xhtml+xml", Range: `bytes=0-${PAGE_BYTES - 1}` };
  const res = get(url, accept, PAGE_TIMEOUT, PAGE_BYTES, dead);
  if (!res || !/html/i.test(res.headers["content-type"] || "")) return null;
  const html = pageText(res);
  if (html === null) return null;
  let title = "";
  let iconRef = "";
  for (const tag of tags(html)) {
    const a = attrs(tag);
    if (!title && /^og:title$/i.test(a.property || a.name || "")) title = clean(a.content || "");
    if (!iconRef && a.href && /^<link/i.test(tag) && (a.rel || "").toLowerCase().split(/\s+/).includes("icon")) iconRef = a.href;
  }
  if (!title) title = clean(titleOf(html));
  if (!title) return null;
  const at = res.url || url;
  const page = parse(at);
  const found = iconRef ? icon(resolve(decode(iconRef), at), dead) : "";
  return { url, title, icon: found || (page ? icon(`${page.origin}/favicon.ico`, dead) : "") };
}

// ---------------------------------------------------------------- the queue and the worker

/**
 * A message saved with new text: look at its links (none: nothing to do). In the save's transaction.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function queue(app, rec) {
  if (!enabled() || rec.getBool("deleted") || !linksOf(rec.getString("text")).length) return;
  const row = new Record(app.findCollectionByNameOrId("link_queue"));
  row.set("message", rec.id);
  app.save(row);
}

/**
 * Previews for one queued message, saved unless its text changed meanwhile (the edit queued it again).
 * @param {core.App} app
 * @param {string} id
 */
function fill(app, id) {
  let msg;
  try {
    msg = app.findRecordById("messages", id);
  } catch {
    return;
  }
  if (msg.getBool("deleted") || !tools(app)) return;
  const text = msg.getString("text");
  const until = Date.now() + MESSAGE_MS;
  /** @type {Set<string>} */
  const dead = new Set();
  /** @type {{ url: string, title: string, icon: string }[]} */
  const previews = [];
  for (const url of linksOf(text)) {
    if (Date.now() > until) break;
    const p = preview(url, dead);
    if (p) previews.push(p);
  }
  if (!previews.length) return;
  app.runInTransaction((tx) => {
    const now = tx.findRecordById("messages", id);
    if (now.getBool("deleted") || now.getString("text") !== text) return;
    now.set("previews", previews);
    tx.save(now);
  });
}

/**
 * One pass: the oldest queued messages. `beat`, if given, is called after each one (the worker renews its lock).
 * @param {core.App} app
 * @param {() => void} [beat]
 */
function pass(app, beat) {
  const rows = app.findRecordsByFilter("link_queue", "", "created,id", BATCH, 0);
  for (const row of rows) {
    if (!row) continue;
    try {
      fill(app, row.getString("message"));
    } catch (err) {
      app.logger().warn("previews: fill", "message", row.getString("message"), "error", String(err));
    }
    try {
      app.delete(row);
    } catch {
      // gone with its message
    }
    beat?.();
  }
  return rows.length;
}

/**
 * The cron job: passes until the minute is nearly over; with nothing to do, when a queued message wakes it (wake). One
 * run at a time.
 * @param {core.App} app
 */
function run(app) {
  require(`${__hooks}/lib/worker.js`).run(app, {
    name: LOCK,
    label: "previews",
    staleMs: STALE_MS,
    wakes: true,
    pass: (/** @type {() => void} */ renew) => pass(app, renew),
  });
}

/**
 * A message was queued (committed): the worker looks at it now.
 * @param {core.App} app
 */
function wake(app) {
  require(`${__hooks}/lib/worker.js`).wake(app, LOCK);
}

/**
 * POST /api/previews/tick (superusers): one pass now.
 * @param {core.RequestEvent} e
 */
function tick(e) {
  while (pass(e.app) === BATCH);
  return e.noContent(204);
}

module.exports = { enabled, linksOf, queue, run, wake, tick };
