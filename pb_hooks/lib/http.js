/// <reference path="../../types/pocketbase.d.ts" />
// Every response's security and cache headers, the built assets, and the client IP behind a proxy (DESIGN.md §5.6, §8.2).

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Security + cache headers for every response (§5.6).
 * @param {core.RequestEvent} e
 */
function headers(e) {
  const path = e.request?.url?.path ?? ""; // always set for a real request; optional in the generated types
  const h = e.response.header();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  // The admin UI (/_/) relies on inline scripts/styles; the API serves JSON.
  if (!path.startsWith("/_/") && !path.startsWith("/api/")) {
    h.set("Content-Security-Policy", CSP);
    // Only content-hashed names (esbuild "[name]-[hash]", 8 chars) are immutable; dev builds are unhashed.
    if (/^\/assets\/.+-[A-Z0-9]{8}\.(js|css)(\.map)?$/.test(path)) h.set("Cache-Control", "public, max-age=31536000, immutable");
    else h.set("Cache-Control", "no-cache");
  }
}

/** The directory the app is served from: `--publicDir`, else PocketBase's default, pb_public beside the executable. */
function publicDir() {
  const args = $os.args;
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--publicDir=")) return args[i].slice("--publicDir=".length);
    if (args[i] === "--publicDir") return args[i + 1];
  }
  return $filepath.join($filepath.dir(args[0]), "pb_public");
}

/**
 * GET /assets/{path...}: the built JS and CSS (§8.2). A missing file is a 404, not the app's index.html, which
 * PocketBase serves for any other path (§7.1). As index.html, an old build's lazy chunk (a tab still open across a
 * deploy) would fail as a script anyway, and its content-hashed URL would keep that HTML cached for a year.
 * @param {core.RequestEvent} e
 */
function asset(e) {
  const dir = $filepath.join(publicDir(), "assets");
  const path = e.request?.pathValue("path") ?? "";
  try {
    if (path.split("/").includes("..")) throw new Error("outside assets/");
    if ($os.stat($filepath.join(dir, path)).isDir()) throw new Error("a directory");
  } catch {
    e.response.header().set("Cache-Control", "no-store");
    throw new NotFoundError();
  }
  return $apis.static(dir, false)(e);
}

/**
 * Who the client is behind a reverse proxy (Dokku, nginx, Caddy…). PocketBase rate limits per client IP, and without a
 * trusted header every request comes from the proxy: each per-IP limit would be one limit for the whole site (a script
 * failing a login every 1.5 s would lock everyone out). `TRUSTED_PROXY` names the header the proxy sets, usually
 * X-Forwarded-For. Its rightmost address is used, the one the proxy itself added, so a client can't choose its own.
 * "off" clears it; unset leaves what the admin chose (Settings → Application). Only set it with a proxy in front:
 * otherwise clients send that header themselves and pick their IP.
 * @param {core.App} app
 */
function trustProxy(app) {
  const value = $os.getenv("TRUSTED_PROXY").trim();
  if (!value) return;
  const headers = value.toLowerCase() === "off" ? [] : [value];
  const settings = app.settings();
  const now = settings.trustedProxy;
  if (now.headers.join(",") === headers.join(",") && !now.useLeftmostIP) return;
  now.headers = headers;
  now.useLeftmostIP = false;
  app.save(settings);
}

module.exports = { headers, asset, trustProxy };
