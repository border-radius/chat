// Room access dialog (§23.2): the creator chooses who can see the room (Private, Public or Open Air) and, for a private
// room, who its members are. Anyone else in a private room gets the same dialog to see who is in it, read-only.
// A modal <dialog>: it keeps focus inside, Escape closes it, and focus goes back to where it was.

import { h, uniqueId } from "../../dom.ts";
import { LIMITS } from "../../lib/limits.ts";
import { VISIBILITY, visibilityOf } from "../../lib/rooms.ts";
import type { Room, User, Visibility } from "../../lib/types.ts";
import { type AvatarUrl, avatar } from "../../ui/avatar.ts";
import { createUserSearch, type UserSearch } from "../../ui/user-search.ts";

export interface AccessDialog {
  readonly el: HTMLDialogElement;
  /** Open it for `room`: to change its access when `editable`, else to see its members. `me` names you in the list. */
  open(room: Room, editable: boolean, me: User | null): void;
  close(): void;
}

const CHOICES: readonly Visibility[] = ["private", "public", "open"];

/** What a change of visibility does that may not be obvious, or "". */
function warning(from: Visibility, to: Visibility): string {
  if (from === to) return "";
  if (to === "open") return "Everything ever written here, and everything to come, becomes readable by anyone on the web.";
  if (from === "private") return "Everyone with an account will be able to read the whole history.";
  if (to === "private") return "Only you and the people you add will see this room. Everyone else loses it from their list.";
  return "People without an account won't see this room any more.";
}

export function createAccessDialog(opts: {
  searchUsers: (query: string, signal: AbortSignal) => Promise<User[]>;
  avatarUrl: AvatarUrl;
  /** Save. Resolves to what went wrong, or null once it is saved (the dialog then closes). */
  onSave: (visibility: Visibility, members: string[]) => Promise<string | null>;
  signal: AbortSignal;
}): AccessDialog {
  const { signal } = opts;
  const id = uniqueId("access");
  const title = h("h2", { id: `${id}-title` });
  const legend = h("legend", {});
  const radios = new Map<Visibility, HTMLInputElement>();
  const choices = h("fieldset", { class: "vis-choices" }, [
    legend,
    ...CHOICES.map((v) => {
      const input = h("input", {
        type: "radio",
        name: `${id}-vis`,
        value: v,
        "aria-labelledby": `${id}-${v}-label`,
        "aria-describedby": `${id}-${v}-hint`,
        on: { change: () => setVisibility(v) },
        signal,
      });
      radios.set(v, input);
      return h("label", { class: `vis-choice vis-${v}` }, [
        input,
        h("span", { class: "vis-icon", "aria-hidden": "true" }, VISIBILITY[v].icon),
        h("span", { class: "vis-text" }, [
          h("span", { id: `${id}-${v}-label`, class: "vis-label" }, VISIBILITY[v].label),
          h("span", { id: `${id}-${v}-hint`, class: "vis-hint" }, VISIBILITY[v].hint),
        ]),
      ]);
    }),
  ]);
  const membersHead = h("h3", {});
  const memberList = h("ul", { class: "member-list", "aria-label": "Members" });
  const addBtn = h("button", { type: "button", class: "link add-member", on: { click: () => toggleSearch(true) }, signal }, "+ Add people");
  const searchSlot = h("div", { class: "member-search" });
  const members = h("section", { class: "members" }, [membersHead, memberList, addBtn, searchSlot]);
  const warn = h("p", { class: "access-warning", role: "status" });
  const error = h("p", { class: "field-error", role: "alert" });
  const cancel = h("button", { type: "button", class: "cancel", on: { click: () => close() }, signal }, "Cancel");
  const save = h("button", { type: "button", class: "primary save", on: { click: () => void submit() }, signal }, "Save");
  const buttons = h("div", { class: "dialog-actions" }, [cancel, save]);
  const el = h("dialog", { class: "access", "aria-labelledby": title.id }, [title, choices, members, warn, error, buttons]);

  let room: Room | null = null;
  let editable = false;
  let visibility: Visibility = "public";
  /** The members as chosen so far, the creator first. */
  let people: User[] = [];
  let search: { ac: AbortController; ui: UserSearch } | null = null;
  let busy = false;

  function setVisibility(v: Visibility) {
    visibility = v;
    error.textContent = "";
    render();
  }

  function render() {
    if (!room) return;
    for (const [v, input] of radios) input.checked = v === visibility;
    choices.hidden = !editable;
    members.hidden = visibility !== "private";
    membersHead.textContent = `Members (${people.length})`;
    const full = people.length >= LIMITS.roomMembers;
    addBtn.hidden = !editable || !!search;
    addBtn.disabled = full;
    addBtn.title = full ? `A room can have up to ${LIMITS.roomMembers} members.` : "";
    memberList.replaceChildren(
      ...people.map((u) => {
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
                  on: { click: () => remove(u.id) },
                  signal,
                },
                "Remove",
              )
            : null,
        ]);
      }),
    );
    warn.textContent = editable ? warning(visibilityOf(room), visibility) : "";
    save.hidden = !editable;
    cancel.textContent = editable ? "Cancel" : "Close";
  }

  function remove(userId: string) {
    const at = people.findIndex((u) => u.id === userId);
    people = people.filter((u) => u.id !== userId);
    render();
    // Focus stays in the list: on the next member's Remove, else the previous one's, else Add people.
    const buttons = [...memberList.querySelectorAll<HTMLButtonElement>("button.remove-member")];
    (buttons[Math.min(at - 1, buttons.length - 1)] ?? addBtn).focus();
  }

  function add(u: User) {
    if (people.some((p) => p.id === u.id)) return;
    if (people.length >= LIMITS.roomMembers) {
      error.textContent = `A room can have up to ${LIMITS.roomMembers} members.`;
      return;
    }
    people = [...people, u];
    error.textContent = "";
    render();
  }

  function toggleSearch(on: boolean) {
    if (on === !!search) return;
    search?.ac.abort();
    search = null;
    if (on) {
      const ac = new AbortController();
      signal.addEventListener("abort", () => ac.abort(), { once: true });
      const ui = createUserSearch({
        search: opts.searchUsers,
        avatarUrl: opts.avatarUrl,
        onPick: add,
        onClose: () => {
          toggleSearch(false);
          addBtn.focus();
        },
        signal: ac.signal,
      });
      search = { ac, ui };
      searchSlot.replaceChildren(ui.el);
      render();
      ui.focus();
    } else {
      searchSlot.replaceChildren();
      render();
    }
  }

  async function submit() {
    if (busy || !room || !editable) return;
    busy = true;
    save.disabled = cancel.disabled = true;
    error.textContent = "";
    const problem = await opts.onSave(
      visibility,
      people.map((u) => u.id),
    );
    busy = false;
    save.disabled = cancel.disabled = false;
    if (signal.aborted) return;
    if (problem === null) return close();
    error.textContent = problem;
    if (!el.open) el.showModal();
  }

  function close() {
    toggleSearch(false);
    if (el.open) el.close();
  }

  // Escape in the people search closes the search, not the dialog; while saving, nothing closes it.
  el.addEventListener(
    "cancel",
    (e) => {
      if (busy) e.preventDefault();
      else if (search) {
        e.preventDefault();
        toggleSearch(false);
        addBtn.focus();
      }
    },
    { signal },
  );
  el.addEventListener("close", () => toggleSearch(false), { signal });
  signal.addEventListener("abort", close, { once: true });

  return {
    el,
    open(r, canEdit, me) {
      room = r;
      editable = canEdit;
      visibility = visibilityOf(r);
      const known = new Map((r.expand?.members ?? []).map((u) => [u.id, u]));
      // A public room made private starts with its creator, who isn't expanded yet.
      if (me && !known.has(me.id)) known.set(me.id, me);
      const ids = r.members?.length ? r.members : [r.created_by];
      people = ids.map((uid) => known.get(uid) ?? { id: uid, name: "Unknown" });
      // The creator first, as the server keeps them.
      people.sort((a, b) => Number(b.id === r.created_by) - Number(a.id === r.created_by));
      title.textContent = editable ? "Room access" : `Members of #${r.name}`;
      legend.textContent = `Who can see #${r.name}?`;
      error.textContent = "";
      toggleSearch(false);
      render();
      if (!el.open) el.showModal();
      (editable ? radios.get(visibility) : cancel)?.focus();
    },
    close,
  };
}
