/// <reference path="../../types/pocketbase.d.ts" />
// Where the server may go (DESIGN.md §28, §33): link previews (lib/previews.js) and linked instances (federation/net.js)
// fetch from addresses anyone can give, so only public web addresses: http(s) on the default port, a host name with a
// dot that isn't a local one, or a public IPv4 address; never userinfo or IPv6 literals. A name is looked up first
// (getent) and all its addresses must be public; the caller then connects to the one checked and no other. Hosts in
// LINK_PREVIEWS_ALLOW_HOSTS (comma-separated, host or host:port; tests) are let through without checks.

const LOOKUP_TIMEOUT = 3;

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

module.exports = { parse, allowedHosts, publicHost, publicIPv4, addressOf, resolve };
