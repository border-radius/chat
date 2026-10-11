// The message list DOM (§7.5, §7.6.1, §7.6.2): renders a MessageWindow with author groups and day dividers,
// reusing each message's element until something it shows changes. Owns the per-message UI state (edit box,
// delete confirm, inline errors); what those buttons *do* is up to the room view.

import { h, reconcile } from "../../dom.ts";
import { attachmentName, isImage } from "../../lib/files.ts";
import { type MessageWindow, quoteText, startsGroup } from "../../lib/messages.ts";
import { captureAnchor, restoreAnchor } from "../../lib/scroll.ts";
import { dayLabel, formatFull, formatTime, parsePb } from "../../lib/time.ts";
import type { Message, Quoted, User } from "../../lib/types.ts";
import { type AvatarUrl, avatar } from "../../ui/avatar.ts";
import { createActionMenu } from "../../ui/menu.ts";
import { editProblem, fitRows, rowsFor } from "./composer.ts";

export interface MsgError {
  text: string;
  retry: () => void;
}

/** What to render, read fresh on every render. */
export interface ListState {
  win: MessageWindow;
  /** The first load is done (until then, no "beginning of the room" marker). */
  ready: boolean;
  /** The first load failed: show an error with Retry instead of the (empty) window. */
  failed: boolean;
  /** Text of the "beginning of the room" marker. */
  beginning: string;
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

/** At most this many characters of a quote are in its accessible name. */
const QUOTE_SPOKEN = 80;

const byId = (id: string) => `li.msg[data-id="${CSS.escape(id)}"]`;

export function createMessageList(opts: {
  state: () => ListState;
  me: () => User | null;
  editable: (m: Message) => boolean;
  /** Does the message get a Reply button? (§19) */
  repliable: (m: Message) => boolean;
  /** Reply on a message. */
  onReply: (id: string) => void;
  /** A reply's quote was clicked: show the message it answers. */
  onOpenQuote: (id: string) => void;
  onSaveEdit: (id: string, text: string) => void;
  /** Escape in the edit box (after it has closed). */
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  onRetrySend: (id: string) => void;
  onDiscard: (id: string) => void;
  /** Retry button of a failed first load. */
  onRetryLoad: () => void;
  avatarUrl: AvatarUrl;
  /** "Message" in an author's menu (§16.5). */
  onMessageUser: (userId: string) => void;
  /** Signed URL of an attachment (§17.3). */
  fileUrl: (m: Message, filename: string, thumb?: string) => string;
  /** Get a new file token (an image failed to load, maybe because its token expired). */
  refreshFileToken: () => Promise<unknown>;
  signal: AbortSignal;
}): MessageList {
  const { signal } = opts;
  const el = h("ol", { class: "messages", "aria-live": "polite", "aria-busy": "true", "aria-label": "Messages" });
  const topSentinel = h("li", { class: "sentinel", dataset: { sentinel: "top" }, "aria-hidden": "true" });
  const bottomSentinel = h("li", { class: "sentinel", dataset: { sentinel: "bottom" }, "aria-hidden": "true" });
  const beginning = h("li", { class: "beginning" });
  const loadError = h("li", { class: "load-error", role: "alert" }, [
    "Couldn't load this room. Check your connection. ",
    h("button", { type: "button", class: "link", on: { click: () => opts.onRetryLoad() }, signal }, "Retry"),
  ]);

  // Day dividers ("Today") and time-only stamps depend on the current date: redraw when it changes.
  let midnight: ReturnType<typeof setTimeout> | undefined;
  const scheduleMidnight = () => {
    const next = new Date();
    next.setHours(24, 0, 1, 0);
    midnight = setTimeout(() => {
      render({ anchor: true });
      scheduleMidnight();
    }, next.getTime() - Date.now());
  };
  scheduleMidnight();
  signal.addEventListener("abort", () => clearTimeout(midnight), { once: true });

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
    const hintText = "Enter to save · Esc to cancel";
    const hint = h("p", { class: "hint", "aria-live": "polite" }, hintText);
    const box = h("textarea", {
      class: "edit-input",
      rows: rowsFor(m.text),
      "aria-label": "Edit message",
      value: m.text,
      on: {
        input: (e) => {
          fitRows(e.currentTarget as HTMLTextAreaElement);
          hint.textContent = hintText;
          hint.classList.remove("error");
        },
        keydown: (e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            const value = (e.currentTarget as HTMLTextAreaElement).value;
            const problem = editProblem(value, !!m.files?.length);
            if (problem) {
              // Say why nothing happens (an empty edit is not a delete; over-long text can't be saved).
              hint.textContent = problem;
              hint.classList.add("error");
              return;
            }
            opts.onSaveEdit(m.id, value);
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
    return [box, hint];
  }

  /**
   * What a reply shows of the message it answers: the copy in the window when there is one (it follows edits and
   * deletes live), else the one the server expanded. Null when it isn't a reply.
   */
  function quotedOf(m: Message, win: MessageWindow): Quoted | null {
    if (!m.reply_to) return null;
    const inWindow = win.items.find((x) => x.id === m.reply_to);
    return inWindow ?? m.expand?.reply_to ?? { id: m.reply_to, author: "", text: "", deleted: true };
  }

  function messageNode(m: Message, groupStart: boolean, targetId: string | null, quoted: Quoted | null): HTMLElement {
    const err = errors.get(m.id);
    const editable = opts.editable(m);
    const repliable = opts.repliable(m);
    const ms = parsePb(m.created);
    const sig = JSON.stringify([
      m.text,
      m.deleted,
      m.edited_at,
      m.status ?? "",
      m.created,
      formatTime(ms), // changes at midnight ("7:36 PM" → "Oct 10, 7:36 PM")
      groupStart,
      editable,
      repliable,
      quoted ? [quoted.expand?.author?.name ?? "", quoteText(quoted)] : null,
      editing === m.id,
      confirmDelete === m.id,
      err?.text ?? "",
      targetId === m.id,
      m.expand?.author?.name ?? "",
      m.expand?.author?.avatar ?? "",
      (m.files ?? []).join("/"),
      (m.localFiles ?? []).map((f) => f.url || f.file.name).join("/"),
    ]);
    const hit = cache.get(m.id);
    if (hit && hit.sig === sig) return hit.el;

    const me = opts.me();
    const author: User = m.expand?.author ?? (me && m.author === me.id ? me : { id: m.author, name: "Unknown" });
    const cls = ["msg", groupStart && "group-start", m.status, m.deleted && "deleted", targetId === m.id && "target"]
      .filter(Boolean)
      .join(" ");

    const parts: (HTMLElement | null)[] = [];
    if (groupStart) {
      parts.push(avatar(author, 32, opts.avatarUrl));
      parts.push(
        h("div", { class: "meta" }, [
          authorEl(author, me, !!m.expand?.author),
          h("time", { datetime: new Date(ms).toISOString(), title: formatFull(ms) }, formatTime(ms)),
        ]),
      );
    }
    if (quoted) parts.push(quote(quoted));
    if (editing === m.id) {
      parts.push(...editBox(m));
    } else {
      parts.push(m.deleted ? h("div", { class: "body placeholder" }, "Message deleted") : h("div", { class: "body" }, m.text));
      if (m.edited_at && !m.deleted)
        parts.push(h("span", { class: "edited", title: `Edited ${formatFull(parsePb(m.edited_at))}` }, "(edited)"));
    }
    if (!m.deleted) parts.push(attachments(m));
    if (m.status === "failed") {
      // The original went away while this reply was sending: Retry sends it without the quote (§19).
      const replyGone = !!quoted?.deleted;
      parts.push(
        h("div", { class: "send-error" }, [
          replyGone ? "Not sent: the message you replied to was deleted. " : "Not sent. ",
          btn(replyGone ? "Send without quote" : "Retry", () => opts.onRetrySend(m.id)),
          btn("Discard", () => opts.onDiscard(m.id)),
        ]),
      );
    }
    if (confirmDelete === m.id) {
      parts.push(
        h(
          "div",
          {
            class: "confirm",
            role: "group",
            "aria-label": "Confirm delete",
            on: {
              keydown: (e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                cancelDelete(m.id);
              },
            },
            signal,
          },
          [
            "Delete this message? ",
            btn(
              "Delete message",
              () => {
                confirmDelete = null;
                opts.onDelete(m.id);
              },
              "danger",
            ),
            btn("Cancel", () => cancelDelete(m.id), "cancel"),
          ],
        ),
      );
    } else if (editing !== m.id && (repliable || editable)) {
      parts.push(
        h("div", { class: "actions" }, [
          repliable ? btn("Reply", () => opts.onReply(m.id), "reply") : null,
          editable ? btn("Edit", () => list.startEdit(m.id), "edit") : null,
          editable ? btn("Delete", () => askDelete(m.id), "delete") : null,
        ]),
      );
    }
    if (err) parts.push(h("div", { class: "msg-error", role: "alert" }, [`${err.text} `, btn("Retry", err.retry)]));

    const li = h("li", { class: cls, dataset: { id: m.id } }, parts);
    cache.set(m.id, { sig, el: li });
    return li;
  }

  /**
   * A message's attachments (§17.5): images as fixed-size thumbnails (1 large, or a grid of up to 4 tiles), other
   * files as download chips. A message not yet on the server shows its local previews instead.
   */
  function attachments(m: Message): HTMLElement | null {
    const local = m.localFiles ?? [];
    const names = m.files ?? [];
    if (!local.length && !names.length) return null;
    const imageCount = local.length ? local.filter((f) => f.url).length : names.filter(isImage).length;
    const size = imageCount === 1 ? { w: 240, h: 180, thumb: "480x360" } : { w: 120, h: 90, thumb: "240x180" };
    const images = h("div", { class: `att-images ${imageCount === 1 ? "one" : "grid"}` });
    const others = h("ul", { class: "att-files" });

    if (local.length) {
      for (const f of local) {
        if (f.url)
          images.append(h("span", { class: "att-tile" }, h("img", { src: f.url, width: size.w, height: size.h, alt: f.file.name })));
        else others.append(h("li", {}, h("span", { class: "att-file" }, f.file.name)));
      }
    } else {
      for (const name of names) {
        if (isImage(name)) images.append(imageTile(m, name, size));
        else others.append(h("li", {}, fileLink(m, name, "att-file", [attachmentName(m, name)])));
      }
    }
    return h("div", { class: "attachments" }, [images.childElementCount ? images : null, others.childElementCount ? others : null]);
  }

  /** A link to the full file, re-signed with the current token whenever it is about to be used. */
  function fileLink(m: Message, name: string, cls: string, children: (Node | string)[]): HTMLAnchorElement {
    const a = h(
      "a",
      { class: cls, href: opts.fileUrl(m, name), target: "_blank", rel: "noopener", download: attachmentName(m, name) },
      children,
    );
    const sign = () => (a.href = opts.fileUrl(m, name));
    for (const type of ["pointerenter", "focus", "click"] as const) a.addEventListener(type, sign, { signal });
    return a;
  }

  /** An image thumbnail linking to the full image. A failed load retries once with a new token, then offers Retry. */
  function imageTile(m: Message, name: string, size: { w: number; h: number; thumb: string }): HTMLElement {
    const img = h("img", {
      src: opts.fileUrl(m, name, size.thumb),
      width: size.w,
      height: size.h,
      alt: attachmentName(m, name),
      loading: "lazy",
      decoding: "async",
    });
    const tile = fileLink(m, name, "att-tile", [img]);
    tile.removeAttribute("download"); // open images in a tab rather than download them
    let retried = false;
    img.addEventListener(
      "error",
      () => {
        if (!retried) {
          retried = true;
          void opts.refreshFileToken().then(
            () => (img.src = opts.fileUrl(m, name, size.thumb)),
            () => img.dispatchEvent(new Event("error")),
          );
          return;
        }
        const broken = h("span", { class: "att-tile att-broken" }, [
          "Couldn't load image ",
          btn("Retry", () => {
            retried = false;
            broken.replaceWith(tile);
            img.src = opts.fileUrl(m, name, size.thumb);
          }),
        ]);
        tile.replaceWith(broken);
      },
      { signal },
    );
    return tile;
  }

  /** A reply's quote of the message it answers (§19): clicking it shows that message. */
  function quote(q: Quoted): HTMLElement {
    const name = q.expand?.author?.name ?? "";
    const text = quoteText(q);
    // Spoken as one line, like it is shown: never the whole of a long message. Not "Reply …" either, which is
    // what the Reply button next to it is called.
    const chars = [...text];
    const spoken = chars.length > QUOTE_SPOKEN ? `${chars.slice(0, QUOTE_SPOKEN).join("").trimEnd()}…` : text;
    return h(
      "button",
      {
        type: "button",
        class: `reply-quote${q.deleted ? " deleted" : ""}`,
        title: "Show the original message",
        "aria-label": `Quoting ${name || "a message"}: ${spoken}. Show the original message.`,
        on: { click: () => opts.onOpenQuote(q.id) },
        signal,
      },
      [name ? h("span", { class: "reply-author" }, name) : null, h("span", { class: "reply-text" }, text)],
    );
  }

  /** The author's name: for other (known) users a menu offering "Message" (§16.5). */
  function authorEl(author: User, me: User | null, known: boolean): HTMLElement {
    if (author.id === me?.id || !known) return h("span", { class: "author" }, author.name);
    const menu = createActionMenu({ label: author.name, summary: author.name, className: "author", signal });
    menu.update([{ label: "Message", run: () => opts.onMessageUser(author.id) }]);
    menu.el.classList.add("author-menu");
    return menu.el;
  }

  function divider(ms: number): HTMLElement {
    const label = dayLabel(ms);
    const key = `${new Date(ms).toDateString()}|${label}`;
    let d = dividers.get(key);
    if (!d) {
      d = h("li", { class: "day" }, label);
      dividers.set(key, d);
    }
    return d;
  }

  function render(o: { anchor?: boolean } = {}) {
    if (signal.aborted) return;
    const { win, ready, failed, beginning: beginningText, targetId } = opts.state();
    if (failed) {
      reconcile(el, [loadError]);
      return;
    }
    // An edit box or delete confirm only stays open while its message can still be changed (it may have been
    // deleted in another tab, or the room archived, meanwhile).
    const canChange = (id: string | null) => !!id && win.items.some((m) => m.id === id && opts.editable(m));
    if (!canChange(editing)) editing = null;
    if (!canChange(confirmDelete)) confirmDelete = null;
    beginning.textContent = beginningText;
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
      nodes.push(messageNode(m, newDay || startsGroup(prev, m), targetId, quotedOf(m, win)));
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
      if (focusAfter.caretToEnd && target instanceof HTMLTextAreaElement)
        target.setSelectionRange(target.value.length, target.value.length);
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
