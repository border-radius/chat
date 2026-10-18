/// <reference path="../../types/pocketbase.d.ts" />
// Link previews (DESIGN.md §28): under a message, a line for each link in it, the page's favicon and title. A new
// message, or an edit of the text, queues it (link_queue, in the save's transaction); a worker started by a cron job
// fetches the pages and saves `previews` on the message, which reaches everyone live as an update. Off with
// LINK_PREVIEWS=off.
//
// The server fetches what anyone links to, so it only goes to public web addresses: http(s) on the default port, a
// host name with a dot that isn't a local one, or a public IPv4 address; never userinfo or IPv6 literals. Hosts in
// LINK_PREVIEWS_ALLOW_HOSTS (comma-separated, host or host:port; tests) are let through. Names are not resolved here (the JSVM can't),
// so a public name pointing at a private address, or a redirect to one, still gets through: only a page's title and
// icon are ever kept from it.

const { tidy } = require(`${__hooks}/lib/text.js`);

/** Links looked at in one message. */
const MAX_LINKS = 5;
/** Of a page, only the start is read for its title and icon: the rest is never asked for (Range). */
const PAGE_BYTES = 256 * 1024;
/** A bigger icon is left out: it is kept in the message, as a data: URL. */
const MAX_ICON = 16 * 1024;
const MAX_TITLE = 200;
const PAGE_TIMEOUT = 4;
const ICON_TIMEOUT = 3;
/**
 * A message's links are looked at for this long (ms) at most: links after it get no line. A message linking to sites
 * that never answer would otherwise hold up everyone's previews behind it, for minutes.
 */
const MESSAGE_MS = 12_000;
const UA = "Mozilla/5.0 (compatible; ChatLinkPreview/1.0)";

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

/**
 * May the server fetch from `host`? A public-looking name, or a public IPv4 address.
 * @param {string} host
 */
function publicHost(host) {
  const allowed = $os
    .getenv("LINK_PREVIEWS_ALLOW_HOSTS")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.includes(host)) return true;
  if (/:\d+$/.test(host)) return false; // not the default port
  const h = host.replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return publicIPv4(h.split(".").map(Number));
  // A name needs a dot, a last label of letters (not 0x7f.1 or 2130706433), and not to be a local one.
  return h.includes(".") && /\.[a-z][a-z0-9-]*$|\.xn--[a-z0-9-]+$/.test(h) && !LOCAL.test(h);
}

/** @param {number[]} ip */
function publicIPv4([a, b, c, d]) {
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** @param {string} url */
const fetchable = (url) => {
  const u = parse(url);
  return !!u && publicHost(u.host);
};

/**
 * `ref` (an href from a page) against the page's URL.
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

// ---------------------------------------------------------------- pages and icons

/**
 * GET `url`, null on any failure or a status other than 200/206. A host that didn't answer (a timeout, a refused
 * connection) goes in `dead` and isn't asked again for this message: its links to a site that never answers cost one
 * timeout, not one each.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeout
 * @param {Set<string>} dead
 */
function get(url, headers, timeout, dead) {
  const host = fetchable(url) ? parse(url)?.host : "";
  if (!host || dead.has(host)) return null;
  try {
    const res = $http.send({ url, method: "GET", headers: { "User-Agent": UA, ...headers }, timeout });
    return res.statusCode === 200 || res.statusCode === 206 ? res : null;
  } catch {
    dead.add(host);
    return null;
  }
}

/** @param {{ headers: Record<string, string[]> }} res @param {string} name */
const header = (res, name) => {
  for (const k of Object.keys(res.headers || {})) if (k.toLowerCase() === name) return String((res.headers[k] || [])[0] || "");
  return "";
};

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
  const t = tidy(decode(s));
  const chars = [...t];
  return chars.length > MAX_TITLE
    ? `${chars
        .slice(0, MAX_TITLE - 1)
        .join("")
        .trimEnd()}…`
    : t;
}

/**
 * A tag's attributes, names lowercased.
 * @param {string} tag
 */
function attrs(tag) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([a-z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/**
 * A page's text: UTF-8, or Latin-1 (and Windows-1252, near enough) byte for byte. null for any other charset.
 * @param {any} res
 */
function pageText(res) {
  const body = res.body || [];
  const head = toString(body, 4096);
  const charset = (/charset=["']?([\w-]+)/i.exec(header(res, "content-type")) ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || ["", "utf-8"])[1].toLowerCase();
  if (charset === "utf-8" || charset === "utf8" || charset === "us-ascii") return toString(body, PAGE_BYTES);
  if (!/^(iso-8859-1|latin1|windows-1252|cp1252)$/.test(charset)) return null;
  let s = "";
  for (let i = 0; i < Math.min(body.length, PAGE_BYTES); i++) s += String.fromCharCode(body[i]);
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
 * @param {any} res
 * @param {ArrayLike<number>} b
 */
function imageType(res, b) {
  const served = header(res, "content-type").split(";")[0].trim().toLowerCase();
  if (/^image\/[a-z0-9.+-]+$/.test(served)) return served;
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (/^\s*<(\?xml|svg)/.test(toString(b, 64))) return "image/svg+xml";
  return "";
}

/**
 * An icon as a data: URL, or "".
 * @param {string} url
 * @param {Set<string>} dead
 */
function icon(url, dead) {
  const res = url ? get(url, { Accept: "image/*" }, ICON_TIMEOUT, dead) : null;
  const b = res?.body;
  if (!b?.length || b.length > MAX_ICON) return "";
  const type = imageType(res, b);
  return type ? `data:${type};base64,${base64(b)}` : "";
}

/**
 * What a link shows: the page's title (og:title, else <title>) and its icon. null when there is no title to show.
 * @param {string} url
 * @param {Set<string>} dead
 * @returns {{ url: string, title: string, icon: string } | null}
 */
function preview(url, dead) {
  const res = get(url, { Accept: "text/html,application/xhtml+xml", Range: `bytes=0-${PAGE_BYTES - 1}` }, PAGE_TIMEOUT, dead);
  if (!res || !/html/i.test(header(res, "content-type"))) return null;
  const html = pageText(res);
  if (html === null) return null;
  let title = "";
  let iconRef = "";
  for (const m of html.match(/<(meta|link)\b[^>]*>/gi) || []) {
    const a = attrs(m);
    if (!title && /^og:title$/i.test(a.property || a.name || "")) title = clean(a.content || "");
    if (!iconRef && a.href && /^link/i.test(m.slice(1)) && (a.rel || "").toLowerCase().split(/\s+/).includes("icon")) iconRef = a.href;
  }
  if (!title) title = clean((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || ["", ""])[1]);
  if (!title) return null;
  const page = parse(url);
  const found = iconRef ? icon(resolve(decode(iconRef), url), dead) : "";
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
  if (msg.getBool("deleted")) return;
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

module.exports = { enabled, linksOf, publicHost, resolve, queue, run, tick };
