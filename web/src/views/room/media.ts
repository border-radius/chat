// Media grid (§30): every image and video of a room (or DM), newest first, as square tiles under month headings, in a
// modal <dialog>, so one sent long ago is quick to find. Scrolling down fetches older ones. A tile opens the viewer
// (§17.7) over the grid, stepping through the same images; closing the viewer comes back to the grid, and "Show in
// chat" closes both. Like the viewer it adds a history entry (same URL), so Back closes it rather than leaving the room.
//
// A lazy chunk, like search (§29): the room view import()s it when the grid is first opened, and it links its own
// stylesheet (styles/media.css), so neither app.js nor app.css grows. It imports types only: what it needs from app.js
// comes in its options.

import type { Api } from "../../api.ts";
import type { h } from "../../dom.ts";
import type { Message } from "../../lib/types.ts";
import type { ViewerImage } from "./viewer.ts";

export interface MediaOptions {
  room: string;
  api: Pick<Api, "page" | "fileUrl" | "fileToken">;
  /** A full page of messages (`PAGE_SIZE`): fewer, and there are no more. */
  pageSize: number;
  h: typeof h;
  /** What to call a file (`attachmentName`). */
  name: (m: Message, file: string) => string;
  isMedia: (file: string) => boolean;
  isVideo: (file: string) => boolean;
  /**
   * Show `m`'s `file` in the viewer (the room view's `viewImage`), stepping through `images` (oldest first); `more`:
   * the room has more before them (and none after). `leave` closes the grid ("Show in chat").
   */
  open: (m: Message, file: string, opener: HTMLElement, images: ViewerImage[], more: [boolean, boolean], leave: () => void) => unknown;
  /** Ends it (the room view unmounts). */
  signal: AbortSignal;
}

/** Older messages than `before` (or the newest) that may have files, newest first: `withFiles(older(…))` (lib/cursor.ts). */
export function mediaQuery(room: string, before?: Message) {
  const params: Record<string, string> = { room };
  let filter = "room = {:room}";
  if (before) {
    Object.assign(params, { created: before.created, id: before.id });
    filter += " && (created < {:created} || (created = {:created} && id < {:id}))";
  }
  return { filter: `${filter} && (files:length > 0 || forward_of != "")`, params, sort: "-created,-id" };
}

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const MEDIA_CSS: string;

let stylesheet: Promise<void> | null = null;
/** Loaded once, like the viewer's: a failed load is tried again next time, and the grid opens anyway. */
function loadStylesheet(h: MediaOptions["h"]): Promise<void> {
  stylesheet ??= new Promise((resolve) => {
    const failed = () => {
      link.remove();
      stylesheet = null;
      resolve();
    };
    const link = h("link", { rel: "stylesheet", href: MEDIA_CSS, on: { load: () => resolve(), error: failed } });
    document.head.append(link);
  });
  return stylesheet;
}

/** Marks its history entry; new on every page load, like the viewer's. */
const ENTRY = `media-${Date.now()}-${Math.random()}`;
const onEntry = () => (history.state as { media?: unknown } | null)?.media === ENTRY;
/** A grid closed from itself went Back off its entry and the browser hasn't got there yet: a new one waits for it. */
let leaving: Promise<unknown> | null = null;
/** One grid at a time: the button again does nothing while one is open. */
let current = false;

export function openMedia(o: MediaOptions): void {
  if (current) return;
  current = true;
  const { h, api } = o;
  /** Gets focus back on close (the Media button). */
  const opener = document.activeElement as HTMLElement | null;
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(false), { signal });

  const title = h("h2", { id: "media-title" }, "Media");
  const grid = h("div", { class: "media-grid" });
  const status = h("p", { class: "media-status", role: "status" });
  const body = h("div", { class: "media-body" }, [grid, status]);
  const dialog = h("dialog", { class: "media", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", { type: "button", class: "link", "aria-label": "Close", autofocus: true, on: { click: () => close(true) }, signal }, "×"),
    ]),
    body,
  ]);

  /** What is shown, newest first, and the last message fetched (where older ones begin). */
  const items: ViewerImage[] = [];
  let last: Message | undefined;
  let done = false;
  let loading = false;
  let month = "";
  let closed = false;
  const monthOf = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

  /** The next page of older messages; scrolling near the end asks again until there are tiles below the fold. */
  async function more() {
    if (loading || done || closed) return;
    loading = true;
    status.textContent = "Loading…";
    try {
      const page = await api.page(mediaQuery(o.room, last), signal);
      if (closed) return;
      done = page.length < o.pageSize;
      last = page.at(-1) ?? last;
      for (const m of page) {
        if (m.deleted) continue;
        // Newest first, so a message's files last to first: reversed for the viewer, they are in their own order.
        for (const f of [...(m.files ?? [])].reverse()) if (o.isMedia(f)) add({ message: m, file: f, video: o.isVideo(f) });
      }
      status.textContent = done ? (items.length ? "" : "No photos or videos here yet.") : "";
    } catch {
      if (closed) return;
      // Until Retry: observed again, the end (still in view) would ask again at once, over and over (QA BUG-116).
      seen.unobserve(status);
      status.replaceChildren(
        "Couldn't load media. ",
        h("button", { type: "button", class: "link", on: { click: () => void more() }, signal }, "Retry"),
      );
      return;
    } finally {
      loading = false;
    }
    // Still at the end (a page with few or no media): the observer won't fire again by itself.
    seen.unobserve(status);
    if (!done && !closed) seen.observe(status);
  }

  function add(it: ViewerImage) {
    const { message: m, file, video } = it;
    const d = new Date(m.created.replace(" ", "T"));
    const mo = monthOf.format(d);
    if (mo !== month) {
      month = mo;
      grid.append(h("h3", {}, mo));
    }
    const name = o.name(m, file);
    const src = () => (video ? `${api.fileUrl(m, file)}#t=0.001` : api.fileUrl(m, file, "240x240"));
    const pic = video
      ? h("video", { src: src(), preload: "metadata", muted: true, playsinline: true })
      : h("img", { src: src(), alt: "", loading: "lazy", decoding: "async" });
    let retried = false;
    pic.addEventListener(
      "error",
      () => {
        if (retried) return;
        retried = true;
        void api.fileToken(true).then(
          () => (pic.src = src()),
          () => {},
        );
      },
      { signal },
    );
    const label = `${name}${video ? ", video" : ""}, ${m.expand?.author?.name ?? "Unknown"}, ${d.toLocaleDateString()}`;
    const index = items.push(it) - 1;
    const tile = h(
      "button",
      { type: "button", class: "media-tile", "aria-label": label, title: label, on: { click: () => open(index, tile) }, signal },
      [pic, video && h("span", { "aria-hidden": "true" }, "▶")],
    );
    grid.append(tile);
  }

  function open(index: number, tile: HTMLElement) {
    const { message, file } = items[index]!;
    o.open(message, file, tile, [...items].reverse(), [!done, false], () => close(true, false));
  }

  const seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), {
    root: body,
    rootMargin: "400px",
  });

  /**
   * `back`: closed from the grid itself (×, Escape) or from the viewer's "Show in chat": leave its history entry too.
   * Not when Back closed it, nor when leaving the room (that would undo the navigation). `refocus`: put focus back on
   * the button (not when going to a message: the viewer focuses its tile). The closed dialog stays in the page until
   * then: the router passes over a grid entry with no grid (QA BUG-118), and would go Back a second time.
   */
  function close(back: boolean, refocus = true) {
    if (closed) return;
    closed = true;
    current = false;
    scope.abort();
    seen.disconnect();
    if (dialog.open) dialog.close();
    if (back) leaving = leave().finally(() => dialog.remove());
    else dialog.remove();
    if (refocus) opener?.focus();
  }

  const popped = () => new Promise((r) => window.addEventListener("popstate", r, { once: true }));
  const onViewer = () => !!(history.state as { viewer?: unknown } | null)?.viewer;

  /** Go Back off its entry; when the viewer is still on its way Back to it ("Show in chat"), once it has got there. */
  async function leave() {
    if (!onEntry() && onViewer()) await popped();
    if (!onEntry()) return;
    const gone = popped();
    history.back();
    await gone;
  }

  dialog.addEventListener("close", () => close(true), { signal });

  void (async () => {
    await Promise.all([loadStylesheet(h), leaving]);
    if (closed) return;
    if (!onEntry()) history.pushState({ media: ENTRY }, "");
    // Back left its entry (and not for the viewer's, which is pushed on top of it).
    window.addEventListener("popstate", () => !onEntry() && !onViewer() && close(false), { signal });
    document.body.append(dialog);
    dialog.showModal();
    seen.observe(status);
  })();
}
