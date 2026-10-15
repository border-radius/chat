// Server addresses (servers.ts): pure, so the rules are unit-tested (tests/unit/mobile/urls.test.ts).

/**
 * A typed address as a base URL: "chat.example.com" → "https://chat.example.com". Keeps an explicit http:// (a server
 * on your own network), a port and a path prefix (a server behind a proxy under /chat); drops a trailing slash, and the
 * app's own pages after it ("https://x.com/r/abc" → "https://x.com"). Throws with a sentence when it can't be one.
 */
export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("Enter the server's address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("The address must start with https:// or http://.");
  if (!u.hostname) throw new Error("That doesn't look like a web address.");
  // A link to one of the app's pages (a room, a message, the profile, login, the admin UI) was pasted: the server is
  // what comes before it.
  const path = u.pathname.replace(/\/(r\/[^/]+(\/m\/[^/]+)?|me|login|signup|_(\/.*)?)\/?$/, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** The address as shown in lists: without https:// (http:// stays, as a warning). */
export const displayUrl = (url: string): string => url.replace(/^https:\/\//, "");

export const isInsecure = (url: string): boolean => url.startsWith("http://");

/** A secure-store key for a server's session: only [A-Za-z0-9._-] are allowed, and two servers never share one. */
export function authKey(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `auth.${(h >>> 0).toString(36)}.${url.replace(/[^A-Za-z0-9.-]/g, "_").slice(-80)}`;
}
