/// <reference path="../../types/pocketbase.d.ts" />
// Reading a fetched page for its link preview (DESIGN.md §28): its title, icon link and charset, and an icon as a data:
// URL. Pure: lib/previews.js fetches.

const { tidy } = require(`${__hooks}/lib/text.js`);

const MAX_TITLE = 200;
/** Of a title (or og:title) as written, only the start is cleaned: plenty for MAX_TITLE characters. */
const MAX_RAW_TITLE = 4096;

/** @typedef {{ headers: Record<string, string>, body: any }} Fetched What was fetched (lib/previews.js Response). */

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
 * @param {Fetched} res
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
 * @param {Fetched} res
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

module.exports = { decode, clean, tags, attrs, titleOf, pageText, base64, imageType };
