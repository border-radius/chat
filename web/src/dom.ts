// Minimal DOM helpers (§7.3). Strings always become text nodes: there is no HTML parsing anywhere.

export type Child = Node | string | number | null | undefined | false;

type Listeners = { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };

export interface Attrs {
  class?: string;
  dataset?: Record<string, string>;
  on?: Listeners;
  /** Removes every `on` listener when aborted. */
  signal?: AbortSignal;
  value?: string;
  checked?: boolean;
  [attr: string]: unknown;
}

const PROPS = new Set(["value", "checked"]);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children?: Child | Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, dataset, on: listeners, signal, ...rest } = attrs;
  if (cls) el.className = cls;
  if (dataset) Object.assign(el.dataset, dataset);
  for (const [name, v] of Object.entries(rest)) {
    if (v === undefined || v === null || v === false) continue;
    if (PROPS.has(name)) (el as unknown as Record<string, unknown>)[name] = v;
    else el.setAttribute(name, v === true ? "" : String(v));
  }
  if (listeners) {
    for (const [type, fn] of Object.entries(listeners)) {
      el.addEventListener(type, fn as EventListener, signal ? { signal } : undefined);
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child | Child[]): void {
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

let idSeq = 0;

/** A document-unique id for label/aria wiring, e.g. uniqueId("room") → "room-3". */
export function uniqueId(prefix: string): string {
  return `${prefix}-${++idSeq}`;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/**
 * Make `parent`'s children exactly `nodes`, in order, moving only what differs (§7.5: the message list is
 * never fully re-rendered). Nodes already in place keep their identity, focus and scroll anchoring.
 */
export function reconcile(parent: Element, nodes: readonly Node[]): void {
  // Drop what goes first: a replaced node left in place would push every node after it down one, and each of them
  // would then be moved (re-inserted, restyled) instead of left alone.
  const keep = new Set(nodes);
  for (const c of [...parent.childNodes]) if (!keep.has(c)) c.remove();
  nodes.forEach((node, i) => {
    const at = parent.childNodes[i];
    if (at !== node) parent.insertBefore(node, at ?? null);
  });
}
