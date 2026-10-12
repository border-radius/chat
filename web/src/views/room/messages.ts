// The message list DOM (§7.5, §7.6.1, §7.6.2): renders a MessageWindow with author groups and day dividers,
// reusing each message's element until something it shows changes. Owns the per-message UI state (edit box,
// delete confirm, inline errors), shows reactions (§20.3) and which messages are selected (§21.1); what those buttons
// *do* is up to the room view.

import { h, reconcile } from "../../dom.ts";
import { attachmentName, isImage } from "../../lib/files.ts";
import { type MessageWindow, quoteText, startsGroup } from "../../lib/messages.ts";
import { reactors } from "../../lib/reactions.ts";
import { captureAnchor, restoreAnchor } from "../../lib/scroll.ts";
import { dayLabel, formatFull, formatTime, parsePb } from "../../lib/time.ts";
import type { LocalFile, Message, Quoted, Reaction, User } from "../../lib/types.ts";
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
  /** The selected messages while selecting (§21.1), else null. */
  selected: ReadonlySet<string> | null;
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
  /**
   * Focus the first of `selectors` found in message `id`: now, or after the next render (`later`), since a
   * message's element is rebuilt when what it shows changes.
   */
  focusIn(id: string, selectors: readonly string[], later?: boolean): void;
}

/** Where focus goes in a message after its reactions change: the reaction, else the buttons that add one. */
export const reactionFocus = (emoji: string): readonly string[] => [
  `.reactions [data-emoji="${CSS.escape(emoji)}"]`,
  ".reactions .add-reaction",
  ".actions .react",
];

/** At most this many characters of a quote are in its accessible name. */
const QUOTE_SPOKEN = 80;

const byId = (id: string) => `li.msg[data-id="${CSS.escape(id)}"]`;

export function createMessageList(opts: {
  state: () => ListState;
  me: () => User | null;
  /** Does the message get an Edit button? */
  editable: (m: Message) => boolean;
  /** Does the message get a Delete button? */
  deletable: (m: Message) => boolean;
  /** Does the message get a Reply button? (§19) */
  repliable: (m: Message) => boolean;
  /** Reply on a message. */
  onReply: (id: string) => void;
  /** Can the message be selected (and forwarded)? (§21) */
  selectable: (m: Message) => boolean;
  /** Select or unselect a message; the first one starts selecting. */
  onSelect: (id: string) => void;
  /** Forward on a message. */
  onForward: (id: string) => void;
  /** Can I react to the message? (§20) */
  reactable: (m: Message) => boolean;
  /** The message's reactions as they should show (with my changes on their way). */
  reactions: (m: Message) => readonly Reaction[];
  /** A reaction chip was clicked: add (`on`) or take back my `emoji`. */
  onReact: (id: string, emoji: string, on: boolean) => void;
  /** React (or a reactions row's +) was clicked: offer the emoji picker next to `opener`. */
  onPickReaction: (id: string, opener: HTMLElement) => void;
  /** The name of someone not in the window (who reacted), if known yet. */
  nameOf: (userId: string) => string | undefined;
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

  // Selecting (§21.1): a click anywhere on a message selects it, rather than following a link or pressing a button.
  el.addEventListener(
    "click",
    (e) => {
      const t = e.target as Element;
      const li = opts.state().selected && !t.matches("input.select") ? t.closest<HTMLElement>("li.msg") : null;
      if (!li?.querySelector("input.select")) return;
      e.preventDefault();
      e.stopPropagation();
      opts.onSelect(li.dataset.id!);
    },
    { capture: true, signal },
  );

  let editing: string | null = null;
  /**
   * What is typed in the open edit box, once it differs from the message (null: not yet). The box is rebuilt whenever
   * its message is redrawn (a highlight fading, the quoted message edited…), and must keep it (QA BUG-43).
   */
  let editText: string | null = null;
  let confirmDelete: string | null = null;
  const errors = new Map<string, MsgError>();
  const cache = new Map<string, { sig: string; el: HTMLElement }>();
  /** Aspect ratios of a sending message's image previews, so its server thumbnails take their width before loading. */
  const sentRatios = new Map<string, string[]>();
  const dividers = new Map<string, HTMLElement>();
  /** Focus to apply after the next render: message elements are rebuilt when they change. The first selector found wins. */
  let focusAfter: { id: string; selector: string | readonly string[]; caretToEnd?: boolean } | null = null;
  /** Names of the people in the window, for who reacted (rebuilt every render). */
  let names = new Map<string, string>();

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
      value: editText ?? m.text,
      on: {
        input: (e) => {
          editText = (e.currentTarget as HTMLTextAreaElement).value;
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
          } else if (e.key === "Escape" && !e.isComposing) {
            e.preventDefault();
            editing = null;
            editText = null;
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

  function messageNode(
    m: Message,
    groupStart: boolean,
    targetId: string | null,
    quoted: Quoted | null,
    selected: ReadonlySet<string> | null,
  ): HTMLElement {
    const err = errors.get(m.id);
    const selectable = opts.selectable(m);
    /** Selecting: whether this message is one of them (null: it can't be). */
    const picked = selected && selectable ? selected.has(m.id) : null;
    const editable = opts.editable(m);
    const deletable = opts.deletable(m);
    const repliable = opts.repliable(m);
    const reactable = opts.reactable(m);
    const me = opts.me();
    const reactions = m.deleted
      ? []
      : opts.reactions(m).map((r) => ({ ...r, who: reactors(r.users, me?.id ?? "", (id) => names.get(id) ?? opts.nameOf(id)) }));
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
      deletable,
      repliable,
      reactable,
      selectable,
      !!selected,
      picked,
      m.forwarded_from ? (m.expand?.forwarded_from?.name ?? "") : "",
      reactions.map((r) => [r.emoji, r.users.length, r.users.includes(me?.id ?? ""), r.who]),
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

    const author: User = m.expand?.author ?? (me && m.author === me.id ? me : { id: m.author, name: "Unknown" });
    const cls = ["msg", groupStart && "group-start", m.status, m.deleted && "deleted", targetId === m.id && "target", picked && "selected"]
      .filter(Boolean)
      .join(" ");

    const parts: (HTMLElement | null)[] = [];
    if (picked !== null) {
      parts.push(
        h("input", {
          type: "checkbox",
          class: "select",
          checked: picked,
          "aria-label": `Select message from ${author.name}, ${formatFull(ms)}`,
          on: {
            change: (e) => {
              // Shows what is selected, not what was clicked: a refused one (the limit) stays unchecked.
              (e.currentTarget as HTMLInputElement).checked = picked;
              opts.onSelect(m.id);
            },
          },
          signal,
        }),
      );
    }
    if (groupStart) {
      parts.push(avatar(author, 32, opts.avatarUrl));
      parts.push(
        h("div", { class: "meta" }, [
          authorEl(author, me, !!m.expand?.author),
          h("time", { datetime: new Date(ms).toISOString(), title: formatFull(ms) }, formatTime(ms)),
        ]),
      );
    }
    if (m.forwarded_from && !m.deleted) {
      parts.push(h("div", { class: "forwarded" }, `Forwarded from ${m.expand?.forwarded_from?.name ?? "Unknown"}`));
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
    if (reactions.length) parts.push(reactionsRow(m, reactions, reactable, me?.id ?? ""));
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
    if (selected) {
      // Selecting: no actions on single messages.
    } else if (confirmDelete === m.id) {
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
    } else if (editing !== m.id && (reactable || repliable || deletable || selectable)) {
      parts.push(
        h("div", { class: "actions" }, [
          reactable ? pickerButton(m.id, "React", "Add reaction", "react") : null,
          repliable ? btn("Reply", () => opts.onReply(m.id), "reply") : null,
          selectable ? btn("Forward", () => opts.onForward(m.id), "forward") : null,
          selectable ? btn("Select", () => opts.onSelect(m.id), "select") : null,
          editable ? btn("Edit", () => list.startEdit(m.id), "edit") : null,
          deletable ? btn("Delete", () => askDelete(m.id), "delete") : null,
        ]),
      );
    }
    if (err) parts.push(h("div", { class: "msg-error", role: "alert" }, [`${err.text} `, btn("Retry", err.retry)]));

    const li = h("li", { class: cls, dataset: { id: m.id } }, parts);
    cache.set(m.id, { sig, el: li });
    return li;
  }

  /** A button that opens the emoji picker for a reaction to message `id`. */
  function pickerButton(id: string, text: string, label: string, cls: string): HTMLButtonElement {
    const b: HTMLButtonElement = h(
      "button",
      {
        type: "button",
        class: cls,
        title: label,
        "aria-label": label,
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
        on: { click: () => opts.onPickReaction(id, b) },
        signal,
      },
      text,
    );
    return b;
  }

  /**
   * The emoji people reacted with, each with how many (§20.3). Where I can react, each one is a toggle for mine, and a
   * last button adds another; otherwise (an archived room) they only show.
   */
  function reactionsRow(m: Message, reactions: (Reaction & { who: string })[], reactable: boolean, me: string): HTMLElement {
    const chips = reactions.map((r) => {
      const mine = r.users.includes(me);
      const n = r.users.length;
      const content = [h("span", { class: "reaction-emoji" }, r.emoji), h("span", { class: "reaction-count" }, String(n))];
      const attrs = { class: `reaction${mine ? " mine" : ""}`, title: `${r.who} reacted with ${r.emoji}`, dataset: { emoji: r.emoji } };
      if (!reactable) return h("span", attrs, content);
      return h(
        "button",
        {
          ...attrs,
          type: "button",
          "aria-pressed": String(mine),
          "aria-label": `${r.emoji} ${n} ${n === 1 ? "reaction" : "reactions"}`,
          on: { click: () => opts.onReact(m.id, r.emoji, !mine) },
          signal,
        },
        content,
      );
    });
    return h("div", { class: "reactions", role: "group", "aria-label": "Reactions" }, [
      ...chips,
      reactable ? pickerButton(m.id, "☺+", "Add reaction", "add-reaction") : null,
    ]);
  }

  /**
   * A message's attachments (§17.5): images as uncropped thumbnails of a fixed height (1 large, or a row of up to 4
   * small ones), other files as download chips. A message not yet on the server shows its local previews instead.
   */
  function attachments(m: Message): HTMLElement | null {
    const local = m.localFiles ?? [];
    const names = m.files ?? [];
    if (!local.length && !names.length) return null;
    // Shown as an image only if the server will show it as one too, so nothing changes shape once it is sent.
    const shown = (f: LocalFile) => !!f.url && isImage(f.file.name);
    const imageCount = local.length ? local.filter(shown).length : names.filter(isImage).length;
    const thumb = imageCount === 1 ? "800x480f" : "480x240f";
    const images = h("div", { class: `att-images ${imageCount === 1 ? "one" : "row"}` });
    const others = h("ul", { class: "att-files" });

    if (local.length) {
      for (const f of local) {
        if (!shown(f)) {
          others.append(h("li", {}, h("span", { class: "att-file" }, f.file.name)));
          continue;
        }
        const img = h("img", { src: f.url, alt: f.file.name });
        const i = images.childElementCount;
        img.addEventListener(
          "load",
          () => {
            if (!img.naturalWidth || !img.naturalHeight) return;
            const ratios = sentRatios.get(m.id) ?? [];
            ratios[i] = `${img.naturalWidth} / ${img.naturalHeight}`;
            sentRatios.set(m.id, ratios);
          },
          { signal },
        );
        images.append(h("span", { class: "att-tile" }, img));
      }
    } else {
      const ratios = sentRatios.get(m.id);
      for (const name of names) {
        if (isImage(name)) images.append(imageTile(m, name, thumb, ratios?.[images.childElementCount]));
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
  function imageTile(m: Message, name: string, thumb: string, ratio?: string): HTMLElement {
    const img = h("img", {
      src: opts.fileUrl(m, name, thumb),
      alt: attachmentName(m, name),
      loading: "lazy",
      decoding: "async",
    });
    if (ratio) img.style.aspectRatio = ratio;
    const tile = fileLink(m, name, "att-tile", [img]);
    tile.removeAttribute("download"); // open images in a tab rather than download them
    let retried = false;
    img.addEventListener(
      "error",
      () => {
        if (!retried) {
          retried = true;
          void opts.refreshFileToken().then(
            () => (img.src = opts.fileUrl(m, name, thumb)),
            () => img.dispatchEvent(new Event("error")),
          );
          return;
        }
        const broken = h("span", { class: "att-tile att-broken" }, [
          "Couldn't load image ",
          btn("Retry", () => {
            retried = false;
            broken.replaceWith(tile);
            img.src = opts.fileUrl(m, name, thumb);
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

  /** The author's name: for other (known) users a menu offering "Message" (§16.5). Guests can't message (§23.3). */
  function authorEl(author: User, me: User | null, known: boolean): HTMLElement {
    if (!me || author.id === me.id || !known) return h("span", { class: "author" }, author.name);
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
    const { win, ready, failed, beginning: beginningText, targetId, selected } = opts.state();
    el.classList.toggle("selecting", !!selected);
    if (failed) {
      reconcile(el, [loadError]);
      return;
    }
    // An edit box or delete confirm only stays open while its message can still be changed (it may have been
    // deleted in another tab, or the room archived, meanwhile).
    const canChange = (id: string | null, can: (m: Message) => boolean) => !!id && win.items.some((m) => m.id === id && can(m));
    if (selected || !canChange(editing, opts.editable)) {
      editing = null;
      editText = null;
    }
    if (selected || !canChange(confirmDelete, opts.deletable)) confirmDelete = null;
    beginning.textContent = beginningText;
    names = new Map();
    const me = opts.me();
    if (me) names.set(me.id, me.name);
    for (const m of win.items) {
      const a = m.expand?.author;
      if (a) names.set(a.id, a.name);
    }
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
      nodes.push(messageNode(m, newDay || startsGroup(prev, m), targetId, quotedOf(m, win), selected));
      prev = m;
      prevDay = day;
    }
    if (win.hasNewer) nodes.push(bottomSentinel);

    const anchor = o.anchor ? captureAnchor(el, "li.msg") : null;
    // A redrawn edit box is a new element: give it back the focus and caret the old one had (QA BUG-43).
    const box = document.activeElement;
    const typing = box instanceof HTMLTextAreaElement && box.matches("textarea.edit-input") && el.contains(box) ? box : null;
    const caret = typing && ([typing.selectionStart, typing.selectionEnd, typing.selectionDirection] as const);
    // Likewise a button or checkbox in a redrawn message (it changes whenever someone reacts, §20.3, or it is
    // selected, §21.1): focus its replacement.
    const held =
      !typing && (box instanceof HTMLButtonElement || box instanceof HTMLInputElement) && el.contains(box) ? sameButton(box) : null;
    reconcile(el, nodes);
    if (anchor) restoreAnchor(el, anchor);
    if (typing && caret && !typing.isConnected && editing && !focusAfter) {
      const next = el.querySelector<HTMLTextAreaElement>(`${byId(editing)} textarea.edit-input`);
      next?.focus();
      next?.setSelectionRange(...caret);
    }
    if (held && box instanceof HTMLElement && !box.isConnected && !focusAfter)
      find(held.id, held.selectors)?.focus({ preventScroll: true });

    // forget elements for messages no longer in the window
    const live = new Set(win.items.map((m) => m.id));
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);

    if (focusAfter) {
      const target = find(focusAfter.id, focusAfter.selector);
      target?.focus();
      if (focusAfter.caretToEnd && target instanceof HTMLTextAreaElement)
        target.setSelectionRange(target.value.length, target.value.length);
      focusAfter = null;
    }
  }

  /** Where the focused button `b` will be once its message is redrawn: the same button, or the nearest one left. */
  function sameButton(b: HTMLButtonElement | HTMLInputElement): { id: string; selectors: readonly string[] } | null {
    const id = b.closest<HTMLElement>("li.msg")?.dataset.id;
    if (!id) return null;
    if (b instanceof HTMLInputElement) return { id, selectors: ["input.select"] };
    const emoji = b.closest<HTMLElement>(".reactions [data-emoji]")?.dataset.emoji;
    if (emoji) return { id, selectors: reactionFocus(emoji) };
    const cls = b.classList[0];
    const parent = b.parentElement?.classList[0];
    return cls && parent ? { id, selectors: [`.${parent} > .${cls}`] } : null;
  }

  function find(id: string, selector: string | readonly string[]): HTMLElement | null {
    for (const s of typeof selector === "string" ? [selector] : selector) {
      const found = el.querySelector<HTMLElement>(`${byId(id)} ${s}`);
      if (found) return found;
    }
    return null;
  }

  const list: MessageList = {
    el,
    topSentinel,
    bottomSentinel,
    render,
    startEdit(id) {
      editing = id;
      editText = null;
      confirmDelete = null;
      focusAfter = { id, selector: "textarea.edit-input", caretToEnd: true };
      render();
    },
    stopEdit() {
      editing = null;
      editText = null;
    },
    setError(id, error) {
      if (error) errors.set(id, error);
      else errors.delete(id);
    },
    focusIn(id, selectors, later) {
      if (later) focusAfter = { id, selector: selectors };
      else find(id, selectors)?.focus();
    },
  };
  return list;
}
