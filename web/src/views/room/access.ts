// Room access dialog (§23.2, §23.6): the creator chooses who can see the room (Private, Public or Open Air) and, for a
// private room, who its members are; then who can post: everyone who can see it, or only the people they choose.
// Anyone else in a private room gets the same dialog to see who is in it (and who can post), read-only.
// Telegram stand-ins (no_dms, §26.3) are left out of it: the bridge adds them itself, so adding or removing one does
// nothing. They stay members (and writers) when it is saved.
// A modal <dialog>: it keeps focus inside, Escape closes it, and focus goes back to where it was.

import { h, uniqueId } from "../../dom.ts";
import { LIMITS } from "../../lib/limits.ts";
import { postingOf, VISIBILITY, visibilityOf } from "../../lib/rooms.ts";
import type { Posting, Room, User, Visibility } from "../../lib/types.ts";
import { type AvatarUrl, avatar } from "../../ui/avatar.ts";
import { createUserSearch, type UserSearch } from "../../ui/user-search.ts";

export interface AccessDialog {
  readonly el: HTMLDialogElement;
  /** Open it for `room`: to change its access when `editable`, else to see its members. `me` names you in the list. */
  open(room: Room, editable: boolean, me: User | null): void;
  close(): void;
}

const CHOICES: readonly Visibility[] = ["private", "public", "open"];

/** Who can post (§23.6), shown like the visibilities. */
const POSTING: Record<Posting, { label: string; icon: string; hint: string }> = {
  everyone: { label: "Everyone who can see it", icon: "💬", hint: "Guests of an Open Air room only read." },
  selected: { label: "Only people you choose", icon: "✋", hint: "Everyone else reads and reacts, but can't post." },
};

/** What a change of visibility does that may not be obvious, or "". */
function warning(from: Visibility, to: Visibility): string {
  if (from === to) return "";
  if (to === "open") return "Everything ever written here, and everything to come, becomes readable by anyone on the web.";
  if (from === "private") return "Everyone with an account will be able to read the whole history.";
  if (to === "private") return "Only you and the people you add will see this room. Everyone else loses it from their list.";
  return "People without an account won't see this room any more.";
}

/** A list of people with Add and Remove: the members, or who can post. */
interface People {
  readonly el: HTMLElement;
  readonly addBtn: HTMLButtonElement;
  /** Where its search goes. */
  readonly slot: HTMLElement;
  /** Who its search offers. */
  pickable(u: User): boolean;
  list: User[];
  render(): void;
}

export function createAccessDialog(opts: {
  searchUsers: (query: string, signal: AbortSignal) => Promise<User[]>;
  avatarUrl: AvatarUrl;
  /** Save. Resolves to what went wrong, or null once it is saved (the dialog then closes). */
  onSave: (visibility: Visibility, members: string[], posting: Posting, writers: string[]) => Promise<string | null>;
  signal: AbortSignal;
}): AccessDialog {
  const { signal } = opts;
  const id = uniqueId("access");
  const title = h("h2", { id: `${id}-title` });

  /** Radio cards: one fieldset of `values`, each with its icon, label and hint. */
  function cards<T extends string>(
    values: readonly T[],
    info: Record<T, { label: string; icon: string; hint: string }>,
    set: (v: T) => void,
  ) {
    const legend = h("legend", {});
    const radios = new Map<T, HTMLInputElement>();
    const el = h("fieldset", { class: "vis-choices" }, [
      legend,
      ...values.map((v) => {
        const input = h("input", {
          type: "radio",
          name: `${id}-${values[0]}`,
          value: v,
          "aria-labelledby": `${id}-${v}-label`,
          "aria-describedby": `${id}-${v}-hint`,
          on: { change: () => set(v) },
          signal,
        });
        radios.set(v, input);
        return h("label", { class: `vis-choice vis-${v}` }, [
          input,
          h("span", { class: "vis-icon", "aria-hidden": "true" }, info[v].icon),
          h("span", { class: "vis-text" }, [
            h("span", { id: `${id}-${v}-label`, class: "vis-label" }, info[v].label),
            h("span", { id: `${id}-${v}-hint`, class: "vis-hint" }, info[v].hint),
          ]),
        ]);
      }),
    ]);
    return { el, legend, radios };
  }

  const choices = cards(CHOICES, VISIBILITY, (v) => {
    visibility = v;
    changed();
  });
  const postingChoices = cards(["everyone", "selected"] as const, POSTING, (p) => {
    posting = p;
    changed();
  });
  postingChoices.legend.textContent = "Who can post?";

  /**
   * One list of people. `pickable` says who its search offers: the members are anyone; who can post, in a private
   * room, only its members.
   */
  function people(label: string, cls: string, pickable: (u: User) => boolean): People {
    const head = h("h3", {});
    const ul = h("ul", { class: "member-list", "aria-label": label });
    const addBtn = h("button", { type: "button", class: "link add-member", on: { click: () => toggleSearch(p) }, signal }, "+ Add people");
    const slot = h("div", { class: "member-search" });
    // Search above the list, so it stays in reach however many people there are.
    const el = h("section", { class: cls }, [head, addBtn, slot, ul]);
    const p: People = {
      el,
      addBtn,
      slot,
      pickable,
      list: [],
      render() {
        // Hidden, it lists nobody: only the lists in use are in the page.
        const shown = el.hidden ? [] : p.list.filter((u) => !u.no_dms);
        head.textContent = `${label} (${shown.length})`;
        const full = p.list.length >= LIMITS.roomMembers;
        addBtn.hidden = !editable || search?.p === p;
        addBtn.disabled = full;
        addBtn.title = full ? `A room can have up to ${LIMITS.roomMembers} ${label.toLowerCase()}.` : "";
        ul.replaceChildren(
          ...shown.map((u) => {
            const owner = u.id === room?.created_by;
            return h("li", { class: "member", dataset: { userId: u.id } }, [
              avatar(u, 24, opts.avatarUrl),
              h("span", { class: "member-name" }, u.name),
              owner ? h("span", { class: "member-role" }, "creator") : null,
              editable && !owner
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "link remove-member",
                      "aria-label": `Remove ${u.name}`,
                      on: { click: () => remove(p, u.id) },
                      signal,
                    },
                    "Remove",
                  )
                : null,
            ]);
          }),
        );
      },
    };
    return p;
  }

  const members = people("Members", "members", () => true);
  const writers = people("Who can post", "writers", (u) => visibility !== "private" || has(members, u));
  const warn = h("p", { class: "access-warning", role: "status" });
  const error = h("p", { class: "field-error", role: "alert" });
  const cancel = h("button", { type: "button", class: "cancel", on: { click: () => close() }, signal }, "Cancel");
  const save = h("button", { type: "button", class: "primary save", on: { click: () => void submit() }, signal }, "Save");
  const buttons = h("div", { class: "dialog-actions" }, [cancel, save]);
  // The body scrolls; the title and the buttons stay put.
  const body = h("div", { class: "access-body" }, [choices.el, members.el, postingChoices.el, writers.el, warn, error]);
  const el = h("dialog", { class: "access", "aria-labelledby": title.id }, [title, body, buttons]);

  let room: Room | null = null;
  let editable = false;
  let visibility: Visibility = "public";
  let posting: Posting = "everyone";
  const has = (p: People, u: User) => p.list.some((x) => x.id === u.id);
  let search: { ac: AbortController; ui: UserSearch; p: People } | null = null;
  let busy = false;

  function changed() {
    error.textContent = "";
    // Made private: only members can post.
    if (visibility === "private") writers.list = writers.list.filter((u) => has(members, u));
    render();
  }

  function render() {
    if (!room) return;
    for (const [v, input] of choices.radios) input.checked = v === visibility;
    for (const [v, input] of postingChoices.radios) input.checked = v === posting;
    choices.el.hidden = postingChoices.el.hidden = !editable;
    members.el.hidden = visibility !== "private";
    writers.el.hidden = posting !== "selected";
    members.render();
    writers.render();
    warn.textContent = editable ? warning(visibilityOf(room), visibility) : "";
    save.hidden = !editable;
    cancel.textContent = editable ? "Cancel" : "Close";
  }

  function remove(p: People, userId: string) {
    const ul = p.el.querySelector("ul")!;
    const at = [...ul.children].findIndex((li) => (li as HTMLElement).dataset.userId === userId);
    p.list = p.list.filter((u) => u.id !== userId);
    // A member taken out can't post either.
    if (p === members) writers.list = writers.list.filter((u) => u.id !== userId);
    render();
    // Focus stays in the list: on the next person's Remove, else the previous one's, else Add people.
    const buttons = [...ul.querySelectorAll<HTMLButtonElement>("button.remove-member")];
    (buttons[Math.min(at - 1, buttons.length - 1)] ?? p.addBtn).focus();
  }

  /** A search result picked: add them, or take them out again when they are in. */
  function toggle(p: People, u: User) {
    if (has(p, u)) {
      p.list = p.list.filter((x) => x.id !== u.id);
      if (p === members) writers.list = writers.list.filter((x) => x.id !== u.id);
    } else if (p.list.length >= LIMITS.roomMembers) {
      error.textContent = `A room can have up to ${LIMITS.roomMembers} ${p === members ? "members" : "people who post"}.`;
      return;
    } else p.list = [...p.list, u];
    error.textContent = "";
    render();
    search?.ui.mark();
  }

  /** Open the people search under `p`'s Add button (closing any other), or close it (null). */
  function toggleSearch(p: People | null) {
    if (p === (search?.p ?? null)) return;
    search?.ac.abort();
    search?.p.slot.replaceChildren();
    search = null;
    if (p) {
      const ac = new AbortController();
      signal.addEventListener("abort", () => ac.abort(), { once: true });
      const ui = createUserSearch({
        search: async (q, sig) => (await opts.searchUsers(q, sig)).filter((u) => !u.no_dms && p.pickable(u)),
        avatarUrl: opts.avatarUrl,
        onPick: (u) => toggle(p, u),
        isPicked: (u) => has(p, u),
        onClose: () => {
          toggleSearch(null);
          p.addBtn.focus();
        },
        signal: ac.signal,
      });
      search = { ac, ui, p };
      p.slot.replaceChildren(ui.el);
      render();
      ui.focus();
      // Room for the results under it, on a small screen too.
      p.el.firstElementChild?.scrollIntoView?.({ block: "start" });
    } else render();
  }

  async function submit() {
    if (busy || !room || !editable) return;
    busy = true;
    save.disabled = cancel.disabled = true;
    error.textContent = "";
    const ids = (p: People) => p.list.map((u) => u.id);
    const problem = await opts.onSave(visibility, ids(members), posting, ids(writers));
    busy = false;
    save.disabled = cancel.disabled = false;
    if (signal.aborted) return;
    if (problem === null) return close();
    error.textContent = problem;
    if (!el.open) el.showModal();
  }

  function close() {
    toggleSearch(null);
    if (el.open) el.close();
  }

  // Escape in the people search closes the search, not the dialog; while saving, nothing closes it.
  el.addEventListener(
    "cancel",
    (e) => {
      if (busy) e.preventDefault();
      else if (search) {
        e.preventDefault();
        const p = search.p;
        toggleSearch(null);
        p.addBtn.focus();
      }
    },
    { signal },
  );
  el.addEventListener("close", () => toggleSearch(null), { signal });
  signal.addEventListener("abort", close, { once: true });

  /** The people `ids` names, as expanded, the creator first (as the server keeps them). */
  function users(r: Room, ids: string[], expanded: User[] | undefined, me: User | null) {
    const known = new Map([...(r.expand?.members ?? []), ...(expanded ?? [])].map((u) => [u.id, u]));
    // A room made private (or posting chosen) starts with its creator, who isn't expanded yet.
    if (me && !known.has(me.id)) known.set(me.id, me);
    const list = (ids.length ? ids : [r.created_by]).map((uid) => known.get(uid) ?? { id: uid, name: "Unknown" });
    return list.sort((a, b) => Number(b.id === r.created_by) - Number(a.id === r.created_by));
  }

  return {
    el,
    open(r, canEdit, me) {
      room = r;
      editable = canEdit;
      visibility = visibilityOf(r);
      posting = postingOf(r);
      members.list = users(r, r.members ?? [], undefined, me);
      writers.list = users(r, r.writers ?? [], r.expand?.writers, me);
      title.textContent = editable ? "Room access" : `Members of #${r.name}`;
      choices.legend.textContent = `Who can see #${r.name}?`;
      error.textContent = "";
      toggleSearch(null);
      render();
      if (!el.open) el.showModal();
      (editable ? choices.radios.get(visibility) : cancel)?.focus();
    },
    close,
  };
}
