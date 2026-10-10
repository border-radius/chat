// Scroll helpers for the message list (§7.5).

const STICKY_PX = 80;

export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Within 80px of the bottom (or content shorter than the viewport). */
export function isNearBottom(el: ScrollBox): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= STICKY_PX;
}

export interface Anchor {
  el: HTMLElement;
  /** data-id of the element, to find it again if a re-render replaced it. */
  id: string | undefined;
  /** el.offsetTop − container.scrollTop when captured. */
  offset: number;
}

/** The first element matching `selector` at or below the current scroll position. */
export function captureAnchor(container: HTMLElement, selector: string): Anchor | null {
  const top = container.scrollTop;
  let candidate: HTMLElement | null = null;
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    candidate = el;
    if (el.offsetTop >= top) break;
  }
  return candidate ? { el: candidate, id: candidate.dataset.id, offset: candidate.offsetTop - top } : null;
}

/** After the DOM changed above/below, scroll so the anchor sits where it was. */
export function restoreAnchor(container: HTMLElement, anchor: Anchor | null): void {
  if (!anchor) return;
  const el = container.contains(anchor.el)
    ? anchor.el
    : anchor.id
      ? container.querySelector<HTMLElement>(`[data-id="${CSS.escape(anchor.id)}"]`)
      : null;
  if (el) container.scrollTop = el.offsetTop - anchor.offset;
}
