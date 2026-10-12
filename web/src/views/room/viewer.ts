// Image viewer (§17.7): a room's images full size, one at a time, stepping back and forth with the buttons, the arrow
// keys or a swipe. A modal <dialog> over the whole window: it keeps focus inside, Escape closes it, and focus goes
// back to the thumbnail it was opened from. It adds a history entry (same URL), so Back closes it rather than leaving
// the room.
//
// A lazy chunk: the room view import()s it on the first click on a thumbnail, and it links its own stylesheet. It
// imports types only. Any module it shared with app.js would become a chunk that app.js loads on every page, so
// build.mjs refuses that: what it needs from app.js (the DOM helper, names, dates, signed URLs) comes in its options.

import type { h } from "../../dom.ts";
import type { Message } from "../../lib/types.ts";

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const VIEWER_CSS: string;

/** One image: a stored file of a message. */
export interface ViewerImage {
  message: Message;
  file: string;
}

export interface ViewerOptions {
  /** The images to step through, oldest first. */
  images: readonly ViewerImage[];
  /** Which of them to show first. */
  start: number;
  h: typeof h;
  /** What to call a file (`attachmentName`). */
  name: (m: Message, file: string) => string;
  /** When a message was sent, for the caption. */
  when: (m: Message) => string;
  /** Signed URL of the full file (§17.3). */
  fileUrl: (m: Message, file: string) => string;
  /** Get a new file token (an image failed to load, maybe because its token expired). */
  refreshFileToken: () => Promise<unknown>;
  /** Gets focus back on close. */
  opener: HTMLElement;
  /** Closes the viewer (the room view unmounts). */
  signal: AbortSignal;
}

/** A horizontal move at least this long (px), and mostly horizontal, is a swipe to the next or previous image. */
const SWIPE_PX = 50;

/**
 * Marks the history entry the viewer adds. New on every page load, so an entry left over from before a reload (where
 * no viewer is open) isn't taken for one.
 */
const ENTRY = `viewer-${Date.now()}-${Math.random()}`;
const onEntry = () => (history.state as { viewer?: unknown } | null)?.viewer === ENTRY;

let stylesheet: Promise<void> | null = null;
/**
 * A viewer closed from itself went Back off its entry, and the browser hasn't got there yet: a viewer opened again
 * meanwhile waits for it, or that Back would close it.
 */
let leaving: Promise<unknown> | null = null;
/** The open viewer: opening another one closes it (and takes over its history entry). */
let current: ((back?: boolean) => void) | null = null;

/** Loaded once; a failed load is tried again next time, and the viewer opens anyway (unstyled but usable). */
function loadStylesheet(h: ViewerOptions["h"]): Promise<void> {
  stylesheet ??= new Promise((resolve) => {
    const failed = () => {
      link.remove();
      stylesheet = null;
      resolve();
    };
    const link = h("link", { rel: "stylesheet", href: VIEWER_CSS, on: { load: () => resolve(), error: failed } });
    document.head.append(link);
  });
  return stylesheet;
}

export async function openViewer(o: ViewerOptions): Promise<void> {
  const { h, images } = o;
  current?.();
  if (o.signal.aborted || !images[o.start]) return;
  const scope = new AbortController();
  const { signal } = scope;

  const title = h("h2", { id: "viewer-title" });
  const meta = h("p", { class: "viewer-meta" });
  const count = h("span", { class: "viewer-count" });
  const button = (cls: string, label: string, glyph: string, onClick: () => void, autofocus?: boolean) =>
    h(
      "button",
      { type: "button", class: `viewer-button ${cls}`, "aria-label": label, title: label, autofocus, on: { click: onClick }, signal },
      glyph,
    );
  const download = h("a", { class: "viewer-button", "aria-label": "Download", title: "Download" }, "↓");
  const closeButton = button("", "Close", "×", () => close(true), true);
  const prev = button("viewer-prev", "Previous image", "‹", () => go(-1));
  const next = button("viewer-next", "Next image", "›", () => go(1));
  const img = h("img", { alt: "", decoding: "async" });
  const failure = h("p", { class: "viewer-error", hidden: true }, [
    "Couldn't load image. ",
    h("button", { type: "button", class: "link", on: { click: () => load() }, signal }, "Retry"),
  ]);
  const stage = h("div", { class: "viewer-stage" }, [img, failure, prev, next]);
  const dialog = h("dialog", { class: "viewer", "aria-labelledby": title.id }, [
    h("header", { class: "viewer-bar" }, [
      h("div", { class: "viewer-caption", "aria-live": "polite" }, [title, meta]),
      count,
      download,
      closeButton,
    ]),
    stage,
  ]);

  let index = o.start;
  /** The shown image failed once already: the next failure is final (until Retry). */
  let retried = false;
  let closed = false;

  /**
   * `back`: closed from the viewer itself (Close, Escape, a click beside the image), so also leave its history entry,
   * and Back goes where it went before. Not when Back closed it, and not when leaving the room: that would undo the
   * navigation.
   */
  function close(back = false) {
    if (closed) return;
    closed = true;
    scope.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    img.removeAttribute("src"); // stop a download in progress
    if (current === close) current = null;
    // The thumbnail it was opened from, or the one drawn in its place since (a reaction or an edit redraws the message;
    // a tile that failed to load is a span, counted so the others keep their place).
    const first = images[o.start]!;
    const nth = images.slice(0, o.start).filter((i) => i.message.id === first.message.id).length;
    const tiles = document.querySelectorAll<HTMLElement>(`li.msg[data-id="${CSS.escape(first.message.id)}"] .att-tile`);
    (o.opener.isConnected ? o.opener : tiles[nth])?.focus();
    if (back && onEntry()) {
      leaving = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
      history.back();
    }
  }
  current = close;
  o.signal.addEventListener("abort", () => close(), { signal });

  const shown = () => images[index]!;

  function show(i: number) {
    index = i;
    const { message: m, file } = shown();
    const name = o.name(m, file);
    title.textContent = name;
    meta.textContent = `${m.expand?.author?.name ?? "Unknown"} · ${o.when(m)}`;
    count.textContent = images.length > 1 ? `${i + 1} / ${images.length}` : "";
    download.download = name;
    sign();
    // A step button that goes away at the first or last image hands focus to the other one.
    const focused = document.activeElement;
    prev.hidden = i === 0;
    next.hidden = i === images.length - 1;
    if (focused === prev && prev.hidden) (next.hidden ? closeButton : next).focus();
    if (focused === next && next.hidden) (prev.hidden ? closeButton : prev).focus();
    load();
    // The neighbours, so stepping to them is instant.
    for (const n of [images[i - 1], images[i + 1]]) if (n) new Image().src = o.fileUrl(n.message, n.file);
  }

  function load() {
    const { message: m, file } = shown();
    retried = false;
    failure.hidden = true;
    img.hidden = false;
    img.alt = o.name(m, file);
    stage.classList.add("loading");
    img.src = o.fileUrl(m, file);
  }

  function failed() {
    stage.classList.remove("loading");
    img.hidden = true;
    failure.hidden = false;
  }

  const go = (step: number) => images[index + step] && show(index + step);
  /** The download link gets a fresh token whenever it is about to be used. */
  const sign = () => (download.href = o.fileUrl(shown().message, shown().file));

  img.addEventListener("load", () => stage.classList.remove("loading"), { signal });
  img.addEventListener(
    "error",
    () => {
      if (!img.getAttribute("src")) return;
      if (retried) return failed();
      const at = index;
      void o.refreshFileToken().then(
        () => {
          if (at !== index || closed) return;
          retried = true;
          img.src = o.fileUrl(shown().message, shown().file);
        },
        () => at === index && failed(),
      );
    },
    { signal },
  );
  for (const type of ["pointerenter", "focus", "click"] as const) download.addEventListener(type, sign, { signal });

  // Escape (the dialog's own cancel) and anything else that closes it.
  dialog.addEventListener("close", () => close(true), { signal });
  document.addEventListener(
    "keydown",
    (e) => {
      // Not before it shows (its stylesheet is still loading): the keys are still the page's.
      if (!dialog.open || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const keys: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: images.length - 1 };
      const to = keys[e.key];
      if (to === undefined) return;
      e.preventDefault();
      if (to !== index && images[to]) show(to);
    },
    { signal },
  );

  // Swipe with one finger (pinching to zoom uses two); a click on the dark space around the image closes.
  let swipe: { x: number; y: number } | null = null;
  let swiped = false;
  stage.addEventListener("pointerdown", (e) => (swipe = e.isPrimary ? { x: e.clientX, y: e.clientY } : null), { signal });
  stage.addEventListener("pointercancel", () => (swipe = null), { signal });
  stage.addEventListener(
    "pointerup",
    (e) => {
      if (!swipe || !e.isPrimary) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      swipe = null;
      swiped = Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy);
      if (swiped) go(dx < 0 ? 1 : -1);
    },
    { signal },
  );
  stage.addEventListener(
    "click",
    (e) => {
      if (e.target === stage && !swiped) close(true);
      swiped = false;
    },
    { signal },
  );

  show(index);
  await Promise.all([loadStylesheet(h), leaving]);
  if (closed) return;
  if (!onEntry()) history.pushState({ viewer: ENTRY }, "");
  // Back (or Android's back gesture) left the viewer's entry: the URL is the room's either way, so the router sees nothing.
  window.addEventListener("popstate", () => !onEntry() && close(), { signal });
  document.body.append(dialog);
  dialog.showModal();
}
