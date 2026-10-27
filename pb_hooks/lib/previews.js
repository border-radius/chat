/// <reference path="../../types/pocketbase.d.ts" />
// Link previews (DESIGN.md §28): under a message, a line for each link in it, the page's favicon and title. A new
// message, or an edit of the text, queues it (link_queue, in the save's transaction); a worker started by a cron job
// fetches the pages and saves `previews` on the message, which reaches everyone live as an update. Off with
// LINK_PREVIEWS=off.
//
// The server fetches what anyone links to, so it only goes to public web addresses: http(s) on the default port, a
// host name with a dot that isn't a local one, or a public IPv4 address; never userinfo or IPv6 literals. A name is
// looked up first (getent) and all its addresses must be public; curl then connects to the one checked and no other,
// so a name that answers differently the second time can't send it inward. Redirects are followed here, not by curl,
// each checked the same way. Hosts in LINK_PREVIEWS_ALLOW_HOSTS (comma-separated, host or host:port; tests) are let
// through without checks.
//
// curl, not $http.send: that follows redirects anywhere and reads a whole response into memory, however big (a page
// ignoring Range took 1.1 GB). Of a response only the start is read, from curl's output; then curl is stopped.

const { tidy } = require(`${__hooks}/lib/text.js`);

/** Links looked at in one message. */
const MAX_LINKS = 5;
/** Of a page, only the start is read for its title and icon: the rest is never asked for (Range), nor read. */
const PAGE_BYTES = 256 * 1024;
/** A bigger icon is left out: it is kept in the message, as a data: URL. */
const MAX_ICON = 16 * 1024;
const MAX_TITLE = 200;
/** Of a title (or og:title) as written, only the start is cleaned: plenty for MAX_TITLE characters. */
const MAX_RAW_TITLE = 4096;
/** Seconds for a page, or an icon, redirects included. */
const PAGE_TIMEOUT = 4;
const ICON_TIMEOUT = 3;
const LOOKUP_TIMEOUT = 3;
const MAX_REDIRECTS = 3;
/**
 * A message's links are looked at for this long (ms) at most: links after it get no line. A message linking to sites
 * that never answer would otherwise hold up everyone's previews behind it, for minutes.
 */
const MESSAGE_MS = 12_000;
const UA = "Mozilla/5.0 (compatible; ChirkleLinkPreview/1.0)";

const LOCK = "previews.worker";
const RUN_MS = 57_000;
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

// ---------------------------------------------------------------- where the server may go

/**
 * An http(s) URL split up, or null when it isn't one. Host lowercased, with its port unless it is the default one.
 * @param {string} url
 */
function parse(url) {
  const m = /^(https?):\/\/([^/?#]*)([^#]*)/i.exec(url);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let host = m[2].toLowerCase();
  const port = /:(\d*)$/.exec(host);
  if (port) {
    if (!port[1] || port[1] === (scheme === "https" ? "443" : "80")) host = host.slice(0, -port[0].length);
  }
  if (!host || /[@[\]\\%\s]/.test(host)) return null;
  return { scheme, host, origin: `${scheme}://${host}`, path: m[3] || "/" };
}

const LOCAL = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa)$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** LINK_PREVIEWS_ALLOW_HOSTS: fetched without checks (tests). */
const allowedHosts = () =>
  $os
    .getenv("LINK_PREVIEWS_ALLOW_HOSTS")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

/**
 * May the server fetch from `host`? A public-looking name (its addresses are checked when it is fetched), or a
 * public IPv4 address.
 * @param {string} host
 */
function publicHost(host) {
  if (allowedHosts().includes(host)) return true;
  if (/:\d+$/.test(host)) return false; // not the default port
  const h = host.replace(/\.$/, "");
  if (IPV4.test(h)) return publicIPv4(h);
  // A name: ASCII labels that don't start with "-" (it goes to getent and curl as an argument), a dot, a last label of
  // letters (not 0x7f.1 or 2130706433), and not a local one.
  return (
    h.length <= 253 &&
    h.split(".").every((l) => /^[a-z0-9_][a-z0-9_-]*$/.test(l)) &&
    /\.[a-z][a-z0-9-]*$|\.xn--[a-z0-9-]+$/.test(h) &&
    !LOCAL.test(h)
  );
}

/**
 * A public IPv4 address, in plain decimal: "0177.0.0.1" is 127.0.0.1 to curl, so a leading zero is refused.
 * @param {string} ip
 */
function publicIPv4(ip) {
  if (!IPV4.test(ip) || /(^|\.)0\d/.test(ip)) return false;
  const [a, b, c, d] = ip.split(".").map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/**
 * The address to connect to for a public host: an IPv4 address as is; a name's first address, looked up as the
 * system does (getent), and "" when any of its addresses isn't public (a name may answer with an inward one among
 * others). Throws when the lookup fails.
 * @param {string} host
 */
function addressOf(host) {
  const h = host.replace(/\.$/, "");
  if (IPV4.test(h)) return publicIPv4(h) ? h : "";
  const out = toString($os.cmd("timeout", String(LOOKUP_TIMEOUT), "getent", "ahostsv4", h).output());
  const ips = out
    .split("\n")
    .map((line) => line.split(/\s/)[0])
    .filter((ip) => IPV4.test(ip));
  return ips.length && ips.every(publicIPv4) ? ips[0] : "";
}

/**
 * `ref` (an href from a page, a redirect's Location) against the page's URL.
 * @param {string} ref
 * @param {string} base
 */
function resolve(ref, base) {
  const r = ref.trim();
  const b = parse(base);
  if (!b || !r || /^data:/i.test(r)) return "";
  if (/^https?:\/\//i.test(r)) return r;
  if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return "";
  if (r.startsWith("//")) return `${b.scheme}:${r}`;
  if (r.startsWith("/")) return b.origin + r;
  const dir = b.path.replace(/[?].*$/, "").replace(/[^/]*$/, "");
  return b.origin + (dir || "/") + r;
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
 * One GET with curl (a POST of `data` when given), connecting to `ip` ("": as curl looks the host up, for allowed
 * hosts), reading at most `max` bytes of the body. Throws when there is no response (a timeout, a refused connection).
 * @param {{ origin: string, path: string, scheme: string }} u
 * @param {string} ip
 * @param {Record<string, string>} headers
 * @param {number} seconds
 * @param {number} max
 * @param {string} [data]
 * @returns {Response}
 */
function request(u, ip, headers, seconds, max, data) {
  const head = `${$os.tempDir()}/chirkle-preview-${$security.randomString(16)}`;
  // No ~/.curlrc, no proxy (it would look the host up itself), no globbing of [] and {} in the URL; no redirects (get
  // checks each). The headers go to a file, written as they come: there even when curl is stopped mid-body.
  const args = ["-q", "--silent", "--globoff", "--noproxy", "*", "--proto", "=http,https", "--max-time", seconds.toFixed(1)];
  // Whatever host curl makes of the URL, it connects here.
  if (ip) args.push("--connect-to", `::${ip}:${u.scheme === "https" ? 443 : 80}`);
  args.push("--user-agent", UA);
  for (const [k, v] of Object.entries(headers)) args.push("--header", `${k}: ${v}`);
  // --data-raw: as is, never "@file".
  if (data !== undefined) args.push("--data-raw", data);
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
 * POST `data` to `url`, once: to a public address only (or a host in `allow`), connecting to the address checked,
 * and never following a redirect, which is answered as the status it is. For UnifiedPush (lib/push.js): $http.send
 * follows a redirect anywhere, inward too. Returns the status; throws when there is no answer or the host may not be
 * reached.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string} data
 * @param {number} seconds
 * @param {string[]} allow
 */
function post(url, headers, data, seconds, allow) {
  const u = parse(url);
  if (!u) throw new Error("not an http(s) URL");
  let ip = "";
  if (!allow.includes(u.host)) {
    if (!publicHost(u.host)) throw new Error("not a public host");
    ip = addressOf(u.host);
    if (!ip) throw new Error("not a public address");
  }
  return request(u, ip, headers, seconds, 4096, data).status;
}

// ---------------------------------------------------------------- pages and icons

/** @type {Record<string, string>} */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };

/** @param {string} s */
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
    const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

/**
 * A title as shown: entities decoded, no control or bidi characters (a page's title is anyone's text: "‮" would
 * turn the rest of the line around, QA BUG-110), whitespace collapsed, cut at MAX_TITLE.
 * @param {string} s
 */
function clean(s) {
  const t = tidy(decode(s.slice(0, MAX_RAW_TITLE)));
  const chars = [...t];
  return chars.length > MAX_TITLE
    ? `${chars
        .slice(0, MAX_TITLE - 1)
        .join("")
        .trimEnd()}…`
    : t;
}

// A page is anyone's text, so it is read in one pass, never with a regex that can try again from every "<": a page of
// "<meta <meta …" kept the worker busy for minutes.

/**
 * The page's <meta> and <link> tags, "<" to ">". A tag that never ends ends the search: no tag after it could.
 * @param {string} html
 */
function tags(html) {
  /** @type {string[]} */
  const out = [];
  const start = /<(?:meta|link)\b/gi;
  for (let m = start.exec(html); m; m = start.exec(html)) {
    const end = html.indexOf(">", m.index);
    if (end < 0) break;
    out.push(html.slice(m.index, end + 1));
    start.lastIndex = end + 1;
  }
  return out;
}

const SPACE = " \t\n\r\f";

/**
 * A tag's attributes, names lowercased, the first of each.
 * @param {string} tag
 */
function attrs(tag) {
  /** @type {Record<string, string>} */
  const out = Object.create(null);
  const n = tag.length;
  let i = 1;
  while (i < n && !`${SPACE}/>`.includes(tag[i])) i++; // the tag's name
  while (i < n) {
    while (i < n && `${SPACE}/`.includes(tag[i])) i++;
    if (i >= n || tag[i] === ">") break;
    const from = i;
    while (i < n && !`${SPACE}=/>`.includes(tag[i])) i++;
    if (i === from) {
      i++; // a stray "="
      continue;
    }
    const name = tag.slice(from, i).toLowerCase();
    while (i < n && SPACE.includes(tag[i])) i++;
    let value = "";
    if (tag[i] === "=") {
      i++;
      while (i < n && SPACE.includes(tag[i])) i++;
      const q = tag[i];
      if (q === '"' || q === "'") {
        const end = tag.indexOf(q, i + 1);
        value = tag.slice(i + 1, end < 0 ? n : end);
        i = end < 0 ? n : end + 1;
      } else {
        const at = i;
        while (i < n && !`${SPACE}>`.includes(tag[i])) i++;
        value = tag.slice(at, i);
      }
    }
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/**
 * The text of the page's first <title>, "" when there is none.
 * @param {string} html
 */
function titleOf(html) {
  const open = /<title\b/i.exec(html);
  const start = open ? html.indexOf(">", open.index) : -1;
  if (start < 0) return "";
  const close = /<\/title\s*>/gi;
  close.lastIndex = start + 1;
  const end = close.exec(html);
  return end ? html.slice(start + 1, end.index) : "";
}

/**
 * A page's text: UTF-8, or Latin-1 (and Windows-1252, near enough) byte for byte. null for any other charset.
 * @param {Response} res
 */
function pageText(res) {
  const body = res.body || [];
  const text = toString(body); // at most PAGE_BYTES: all that was read
  let charset = /charset=["']?([\w-]+)/i.exec(res.headers["content-type"] || "")?.[1];
  if (!charset) {
    for (const tag of tags(text.slice(0, 4096))) {
      const a = attrs(tag);
      charset = a.charset || /charset=([\w-]+)/i.exec(a.content || "")?.[1];
      if (charset) break;
    }
  }
  charset = (charset || "utf-8").toLowerCase();
  if (charset === "utf-8" || charset === "utf8" || charset === "us-ascii") return text;
  if (!/^(iso-8859-1|latin1|windows-1252|cp1252)$/.test(charset)) return null;
  let s = "";
  for (let i = 0; i < body.length; i++) s += String.fromCharCode(body[i]);
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** @param {ArrayLike<number>} bytes */
function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

/**
 * An image's type: the one it is served as, else what its first bytes say.
 * @param {Response} res
 * @param {ArrayLike<number>} b
 */
function imageType(res, b) {
  const served = (res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (/^image\/[a-z0-9.+-]+$/.test(served)) return served;
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (/^\s*<(\?xml|svg)/.test(toString(b).slice(0, 64))) return "image/svg+xml";
  return "";
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
 * The cron job: passes, once a second, until the minute is nearly over. One run at a time.
 * @param {core.App} app
 */
function run(app) {
  let mine = false;
  app.store().setFunc(LOCK, (old) => {
    if (old && Date.now() - Number(old) < STALE_MS) return old;
    mine = true;
    return Date.now();
  });
  if (!mine) return;
  // Renewed after every message, not every pass: a pass of slow sites can outlast STALE_MS, and the next minute's run
  // took the lock as stale and fetched the same messages alongside (QA BUG-111).
  const beat = () => app.store().set(LOCK, Date.now());
  try {
    const until = Date.now() + RUN_MS;
    while (Date.now() < until) {
      try {
        if (!pass(app, beat)) sleep(1000);
      } catch (err) {
        app.logger().error("previews: worker", "error", String(err));
        sleep(1000);
      }
      beat();
    }
  } finally {
    app.store().remove(LOCK);
  }
}

/**
 * POST /api/previews/tick (superusers): one pass now.
 * @param {core.RequestEvent} e
 */
function tick(e) {
  while (pass(e.app) === BATCH);
  return e.noContent(204);
}

module.exports = { enabled, linksOf, parse, publicHost, addressOf, resolve, post, queue, run, tick };
