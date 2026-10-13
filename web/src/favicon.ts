// Unread badge on the tab (§22.4): the favicon shows how many messages are unread across every room and DM that has
// a badge in the room list (§18.4), and the title starts with it, e.g. "(3) Chat". The title is the site's (§24).

import { type AppState, type Store, unreadCount } from "./store.ts";

/** Unread messages over every room with a badge, and the open room's while the tab is away. */
export function totalUnread(s: AppState): number {
  let n = 0;
  const view = s.away ? { ...s, activeRoomId: null } : s;
  for (const r of s.rooms.values()) n += unreadCount(view, r);
  return n;
}

/** What the badge says: nothing for 0, "99+" past 99. */
export const badgeLabel = (n: number): string => (n <= 0 ? "" : n > 99 ? "99+" : String(n));

/** The favicon as an SVG document: a speech bubble, with a red badge holding `label` when there is one. */
export function faviconSvg(label: string): string {
  // The app's gradient (--grad in styles/app/tokens.css).
  const bubble =
    '<defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#6a4bff"/><stop offset="1" stop-color="#c42a7c"/></linearGradient></defs>' +
    '<path d="M6 4h20a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H14l-6 6v-6H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="url(#g)"/>' +
    '<path d="M8 11h16M8 17h10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>';
  if (!label) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${bubble}</svg>`;
  // Wider for more digits; the text is the largest that fits.
  const w = label.length === 1 ? 20 : label.length === 2 ? 26 : 32;
  const size = label.length === 3 ? 13 : 16;
  const badge =
    `<rect x="${32 - w}" y="0" width="${w}" height="20" rx="10" fill="#d1213b" stroke="#fff" stroke-width="1.5"/>` +
    `<text x="${32 - w / 2}" y="15" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="700" ` +
    `fill="#fff" text-anchor="middle">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${bubble}${badge}</svg>`;
}

export const faviconUrl = (label: string): string => `data:image/svg+xml,${encodeURIComponent(faviconSvg(label))}`;

/** Keep the favicon and the title in step with the unread counts. Returns a function that stops it. */
export function startFavicon(store: Store<AppState>, doc: Document = document): () => void {
  const title = doc.title;
  let shownTitle: string | null = null;
  // Firefox ignores a new href on the icon's <link>, so each change puts in a fresh one.
  const setIcon = (label: string) => {
    const link = doc.createElement("link");
    link.rel = "icon";
    link.href = faviconUrl(label);
    const old = doc.querySelector('link[rel="icon"]');
    old ? old.replaceWith(link) : doc.head.append(link);
  };
  let shown: string | null = null;
  const render = (s: AppState) => {
    const label = badgeLabel(totalUnread(s));
    if (label !== shown) setIcon(label);
    if (label === shown && s.site.title === shownTitle) return;
    shown = label;
    shownTitle = s.site.title;
    doc.title = label ? `(${label}) ${s.site.title}` : s.site.title;
  };
  render(store.get());
  const off = store.subscribe((s, prev) => {
    if (
      s.unread !== prev.unread ||
      s.rooms !== prev.rooms ||
      s.hidden !== prev.hidden ||
      s.activeRoomId !== prev.activeRoomId ||
      s.away !== prev.away ||
      s.site !== prev.site
    )
      render(s);
  });
  return () => {
    off();
    doc.title = title;
    setIcon("");
  };
}
