// The message list DOM (§7.5, §7.6.1, §7.6.2): renders a MessageWindow with author groups and day dividers,
// reusing each message's element until something it shows changes. Owns the per-message UI state (edit box,
// delete confirm, inline errors); what those buttons *do* is up to the room view.

import { h, reconcile } from "../../dom.ts";
import { startsGroup, type MessageWindow } from "../../lib/messages.ts";
import { captureAnchor, restoreAnchor } from "../../lib/scroll.ts";
import { dayLabel, formatFull, formatTime, parsePb } from "../../lib/time.ts";
import type { Message, User } from "../../lib/types.ts";
import { rowsFor } from "./composer.ts";

export interface MsgError {
  text: string;
  retry: () => void;
}

/** What to render, read fresh on every render. */
export interface ListState {
  win: MessageWindow;
  /** The first load is done (until then, no "beginning of the room" marker). */
  ready: boolean;
  roomName: string | undefined;
  /** Highlighted message (#/r/:id/m/:msgId). */
  targetId: string | null;
}

export interface MessageList {
  readonly el: HTMLOListElement;
  readonly topSentinel: HTMLElement;
  readonly bottomSentinel: HTMLElement;
  /** `anchor`: keep the message at the top of the viewport in place (content changed above it). */
  render(opts?: { anchor?: boolean }): void;
  startEdit(id: string): void;
  /** Close the edit box (no render). */
  stopEdit(): void;
  /** Show or clear an inline error under a message (no render). */
  setError(id: string, error: MsgError | null): void;
}

const byId = (id: string) => `li.msg[data-id="${CSS.escape(id)}"]`;

export function createMessageList(opts: {
  state: () => ListState;
  me: () => User | null;
  editable: (m: Message) => boolean;
  onSaveEdit: (id: string, text: string) => void;
  /** Escape in the edit box (after it has closed). */
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  onRetrySend: (id: string) => void;
  onDiscard: (id: string) => void;
  signal: AbortSignal;
}): MessageList {
  const { signal } = opts;
  const el = h("ol", { class: "messages", "aria-live": "polite", "aria-busy": "true", "aria-label": "Messages" });
  const topSentinel = h("li", { class: "sentinel", dataset: { sentinel: "top" }, "aria-hidden": "true" });
  const bottomSentinel = h("li", { class: "sentinel", dataset: { sentinel: "bottom" }, "aria-hidden": "true" });
  const beginning = h("li", { class: "beginning" });

  let editing: string | null = null;
  let confirmDelete: string | null = null;
  const errors = new Map<string, MsgError>();
  const cache = new Map<string, { sig: string; el: HTMLElement }>();
  const dividers = new Map<string, HTMLElement>();
  /** Focus to apply after the next render: message elements are rebuilt when they change. */
  let focusAfter: { id: string; selector: string; caretToEnd?: boolean } | null = null;

  const btn = (label: string, onClick: () => void, cls?: string) =>
    h("button", { type: "button", ...(cls ? { class: cls } : {}), on: { click: onClick }, signal }, label);

  function askDelete(id: string) {
    confirmDelete = id;
    focusAfter = { id, selector: ".confirm .cancel" };
    render();
  }

  function cancelDelete(id: string) {
    confirmDelete = null;
    focusAfter = { id, selector: ".actions .delete" };
    render();
  }

  function editBox(m: Message): HTMLElement[] {
    const box = h("textarea", {
      class: "edit-input",
      rows: rowsFor(m.text),
      "aria-label": "Edit message",
      value: m.text,
      on: {
        keydown: (e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            opts.onSaveEdit(m.id, (e.currentTarget as HTMLTextAreaElement).value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            editing = null;
            render();
            opts.onCancelEdit();
          }
        },
      },
      signal,
    });
    return [box, h("p", { class: "hint" }, "Enter to save · Esc to cancel")];
  }

  function messageNode(m: Message, groupStart: boolean, targetId: string | null): HTMLElement {
    const err = errors.get(m.id);
    const editable = opts.editable(m);
    const sig = JSON.stringify([
      m.text,
      m.deleted,
      m.edited_at,
      m.status ?? "",
      m.created,
      groupStart,
      editable,
      editing === m.id,
      confirmDelete === m.id,
      err?.text ?? "",
      targetId === m.id,
      m.expand?.author?.name ?? "",
    ]);
    const hit = cache.get(m.id);
    if (hit && hit.sig === sig) return hit.el;

    const me = opts.me();
    const ms = parsePb(m.created);
    const name = m.expand?.author?.name ?? (me && m.author === me.id ? me.name : "Unknown");
    const cls = ["msg", groupStart && "group-start", m.status, m.deleted && "deleted", targetId === m.id && "target"].filter(Boolean).join(" ");

    const parts: (HTMLElement | null)[] = [];
    if (groupStart) {
      parts.push(
        h("div", { class: "meta" }, [
          h("span", { class: "author" }, name),
          h("time", { datetime: new Date(ms).toISOString(), title: formatFull(ms) }, formatTime(ms)),
        ]),
      );
    }
    if (editing === m.id) {
      parts.push(...editBox(m));
    } else {
      parts.push(m.deleted ? h("div", { class: "body placeholder" }, "Message deleted") : h("div", { class: "body" }, m.text));
      if (m.edited_at && !m.deleted) parts.push(h("span", { class: "edited", title: `Edited ${formatFull(parsePb(m.edited_at))}` }, "(edited)"));
    }
    if (m.status === "failed") {
      parts.push(h("div", { class: "send-error" }, ["Not sent. ", btn("Retry", () => opts.onRetrySend(m.id)), btn("Discard", () => opts.onDiscard(m.id))]));
    }
    if (confirmDelete === m.id) {
      parts.push(
        h(
          "div",
          {
            class: "confirm",
            role: "group",
            "aria-label": "Confirm delete",
            on: { keydown: (e) => e.key === "Escape" && (e.preventDefault(), cancelDelete(m.id)) },
            signal,
          },
          [
            "Delete this message? ",
            btn("Delete message", () => ((confirmDelete = null), opts.onDelete(m.id)), "danger"),
            btn("Cancel", () => cancelDelete(m.id), "cancel"),
          ],
        ),
      );
    } else if (editable && editing !== m.id) {
      parts.push(h("div", { class: "actions" }, [btn("Edit", () => list.startEdit(m.id), "edit"), btn("Delete", () => askDelete(m.id), "delete")]));
    }
    if (err) parts.push(h("div", { class: "msg-error", role: "alert" }, [`${err.text} `, btn("Retry", err.retry)]));

    const li = h("li", { class: cls, dataset: { id: m.id } }, parts);
    cache.set(m.id, { sig, el: li });
    return li;
  }

  function divider(ms: number): HTMLElement {
    const label = dayLabel(ms);
    const key = `${new Date(ms).toDateString()}|${label}`;
    let d = dividers.get(key);
    if (!d) dividers.set(key, (d = h("li", { class: "day" }, label)));
    return d;
  }

  function render(o: { anchor?: boolean } = {}) {
    if (signal.aborted) return;
    const { win, ready, roomName, targetId } = opts.state();
    beginning.textContent = roomName ? `Beginning of #${roomName}` : "Beginning of the room";
    const nodes: Node[] = [];
    if (win.hasOlder) nodes.push(topSentinel);
    else if (ready) nodes.push(beginning);
    let prev: Message | undefined;
    let prevDay = "";
    for (const m of win.items) {
      const ms = parsePb(m.created);
      const day = new Date(ms).toDateString();
      const newDay = day !== prevDay;
      if (newDay) nodes.push(divider(ms));
      nodes.push(messageNode(m, newDay || startsGroup(prev, m), targetId));
      prev = m;
      prevDay = day;
    }
    if (win.hasNewer) nodes.push(bottomSentinel);

    const anchor = o.anchor ? captureAnchor(el, "li.msg") : null;
    reconcile(el, nodes);
    if (anchor) restoreAnchor(el, anchor);

    // forget elements for messages no longer in the window
    const live = new Set(win.items.map((m) => m.id));
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);

    if (focusAfter) {
      const target = el.querySelector<HTMLElement>(`${byId(focusAfter.id)} ${focusAfter.selector}`);
      target?.focus();
      if (focusAfter.caretToEnd && target instanceof HTMLTextAreaElement) target.setSelectionRange(target.value.length, target.value.length);
      focusAfter = null;
    }
  }

  const list: MessageList = {
    el,
    topSentinel,
    bottomSentinel,
    render,
    startEdit(id) {
      editing = id;
      confirmDelete = null;
      focusAfter = { id, selector: "textarea.edit-input", caretToEnd: true };
      render();
    },
    stopEdit() {
      editing = null;
    },
    setError(id, error) {
      if (error) errors.set(id, error);
      else errors.delete(id);
    },
  };
  return list;
}
