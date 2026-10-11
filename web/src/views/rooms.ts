// Room list (§7.1, §16.5): Rooms / Direct messages / Hidden / Archived sections, new-room form, user search,
// per-room actions, unread badges (§18.4).
// The data comes from the store, kept live by sync.ts; this view only renders it and issues commands.

import { ApiError, errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { LIMITS, textLength } from "../lib/limits.ts";
import { otherMember, roomTitle } from "../lib/rooms.ts";
import type { Room, User } from "../lib/types.ts";
import type { View } from "../router.ts";
import { createScope, type Scope } from "../scope.ts";
import { roomSections, unreadCount } from "../store.ts";
import { avatar } from "../ui/avatar.ts";
import { type ActionMenu, createActionMenu, type MenuItem } from "../ui/menu.ts";
import { createUserSearch, type UserSearch } from "../ui/user-search.ts";

type Section = "rooms" | "dms" | "hidden" | "archived";

function nameError(err: unknown): string {
  if (err instanceof ApiError && err.codes.name === "validation_not_unique") return "A room with this name already exists.";
  if (err instanceof ApiError && err.fields.name) return err.fields.name;
  return errorMessage(err);
}

export function createRoomsView({ api, store, sync, unread, actions, navigate }: Ctx): View {
  const id = uniqueId("rooms");
  let root: HTMLElement;
  let scope: Scope;

  // UI state that must survive re-renders.
  const open = { hidden: false, archived: false };
  /** Row menus by room id + name, kept across renders so their open/confirm state and focus survive. */
  const menus = new Map<string, ActionMenu>();
  /** The last failed action, shown until the next action or a successful one. */
  let actionError = "";
  /** The "New message" user search, while open (kept across renders, so typing and focus survive). */
  let search: UserSearch | null = null;
  /** The new-room form, built once per mount and shown while `creating` (so a half-typed name survives). */
  let newRoom: { form: HTMLFormElement; input: HTMLInputElement; reset: () => void };
  let creating = false;

  const alert = h("p", { role: "alert", class: "list-error" });
  const nav = h("nav", { "aria-label": "Rooms" });
  const shell = h("section", { class: "rooms", "aria-busy": "true" });

  function renderAlert() {
    clear(alert);
    if (store.get().roomsStatus === "error") {
      alert.append(
        "Couldn't load rooms. Check your connection. ",
        h(
          "button",
          {
            type: "button",
            class: "link",
            on: {
              click: () => {
                void sync.reload();
                unread.refresh();
              },
            },
            signal: scope.signal,
          },
          "Retry",
        ),
      );
    } else {
      alert.append(actionError);
    }
  }

  const title = (r: Room) => roomTitle(r, store.get().user);

  async function act(label: string, room: Room, fn: () => Promise<void>) {
    try {
      await fn();
      actionError = "";
    } catch {
      actionError = `Couldn't ${label} “${room.kind === "dm" ? title(room) : room.name}”. Check your connection and try again.`;
    }
    if (scope.active) renderAlert();
  }

  function toggleSearch(open: boolean) {
    if (open === !!search) return;
    search = open
      ? createUserSearch({
          search: (q, signal) => api.searchUsers(q, signal),
          avatarUrl: api.avatarUrl,
          onPick: (u) => void message(u),
          onClose: () => {
            toggleSearch(false);
            nav.querySelector<HTMLElement>("button.new-dm")?.focus();
          },
          signal: scope.signal,
        })
      : null;
    render();
    search?.focus();
  }

  function toggleNewRoom(open: boolean) {
    if (open === creating) return;
    creating = open;
    if (!open) newRoom.reset();
    render();
    if (open) newRoom.input.focus();
    else nav.querySelector<HTMLElement>("button.new-room-toggle")?.focus();
  }

  async function message(user: User) {
    try {
      const room = await actions.openDm(user.id);
      actionError = "";
      if (!scope.active) return;
      toggleSearch(false);
      navigate(`#/r/${room.id}`);
    } catch (e) {
      actionError = `Couldn't open the conversation with “${user.name}”. ${errorMessage(e)}`;
    }
    if (scope.active) renderAlert();
  }

  const hide = (r: Room) => act("hide", r, () => actions.hide(r.id));
  const unhide = (r: Room) => act("unhide", r, () => actions.unhide(r.id));
  const setArchived = (r: Room, archived: boolean) => act(archived ? "archive" : "unarchive", r, () => actions.setArchived(r.id, archived));

  // ---- rendering ----

  function menuItems(r: Room, section: Section): MenuItem[] {
    const mine = r.created_by === store.get().user?.id;
    const items: MenuItem[] = [];
    if (section === "dms") return [{ label: "Close conversation", run: () => void act("close", r, () => actions.hide(r.id)) }];
    if (section === "rooms") items.push({ label: "Hide", run: () => void hide(r) });
    // An archived room you had hidden is listed under Archived; it can still be unhidden from there.
    if (section === "hidden" || (section === "archived" && store.get().hidden.has(r.id)))
      items.push({ label: "Unhide", run: () => void unhide(r) });
    if (mine && section !== "archived") {
      items.push({
        label: "Archive",
        confirm: { text: `Archive “${r.name}”? It becomes read-only for everyone.`, action: "Archive room" },
        run: () => void setArchived(r, true),
      });
    }
    if (mine && section === "archived") items.push({ label: "Unarchive", run: () => void setArchived(r, false) });
    return items;
  }

  function rowMenu(r: Room, items: MenuItem[], live: Set<string>): HTMLElement | null {
    if (!items.length) return null;
    const name = r.kind === "dm" ? title(r) : r.name;
    const key = `${r.id}|${name}`;
    live.add(key);
    let menu = menus.get(key);
    if (!menu) {
      menu = createActionMenu({ label: `Actions for ${name}`, signal: scope.signal });
      menus.set(key, menu);
    }
    menu.update(items);
    return menu.el;
  }

  function roomRow(r: Room, section: Section, live: Set<string>): HTMLElement {
    const s = store.get();
    const current = s.activeRoomId === r.id;
    const other = r.kind === "dm" ? otherMember(r, s.user) : undefined;
    const n = unreadCount(s, r);
    const label = [
      other ? avatar(other, 24, api.avatarUrl) : null,
      h("span", {}, other ? other.name : r.kind === "dm" ? title(r) : r.name),
      n ? h("span", { class: "badge" }, [n > 99 ? "99+" : n, h("span", { class: "visually-hidden" }, " unread")]) : null,
    ];
    return h("li", { class: r.kind === "dm" ? "dm" : "", dataset: { roomId: r.id } }, [
      h("a", { href: `#/r/${r.id}`, class: n ? "unread" : "", "aria-current": current ? "page" : null }, label),
      rowMenu(r, menuItems(r, section), live),
    ]);
  }

  function collapsible(section: "hidden" | "archived", title: string, rooms: Room[], live: Set<string>): HTMLElement {
    return h(
      "details",
      {
        class: "room-section",
        dataset: { section },
        open: open[section],
        on: { toggle: (e) => (open[section] = (e.currentTarget as HTMLDetailsElement).open) },
        signal: scope.signal,
      },
      [
        h("summary", {}, `${title} (${rooms.length})`),
        h(
          "ul",
          {},
          rooms.map((r) => roomRow(r, section, live)),
        ),
      ],
    );
  }

  function render() {
    if (!scope.active) return;
    const s = store.get();
    const { rooms, dms, hidden, archived } = roomSections(s);
    const loading = s.roomsStatus === "idle" || s.roomsStatus === "loading";
    const live = new Set<string>();
    // Rows are rebuilt; the focused control (a menu button, which is kept) gets its focus back below.
    const focused = nav.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    shell.setAttribute("aria-busy", String(loading));
    const newRoomToggle = h(
      "button",
      {
        type: "button",
        class: "link new-room-toggle",
        "aria-expanded": String(creating),
        on: { click: () => toggleNewRoom(!creating) },
        signal: scope.signal,
      },
      "+ New room",
    );
    const main = h("div", { class: "room-section", dataset: { section: "rooms" } }, [
      h("div", { class: "section-head" }, [h("h2", {}, "Rooms"), newRoomToggle]),
      creating ? newRoom.form : null,
      rooms.length
        ? h(
            "ul",
            {},
            rooms.map((r) => roomRow(r, "rooms", live)),
          )
        : s.roomsStatus === "ready"
          ? h("p", { class: "empty" }, "No rooms yet. Create the first one.")
          : null,
    ]);
    const newDm = h(
      "button",
      {
        type: "button",
        class: "new-dm",
        "aria-label": "New message",
        "aria-expanded": String(!!search),
        title: "New message",
        on: { click: () => toggleSearch(!search) },
        signal: scope.signal,
      },
      "+",
    );
    const direct = h("div", { class: "room-section", dataset: { section: "dms" } }, [
      h("div", { class: "section-head" }, [h("h2", {}, "Direct messages"), newDm]),
      search?.el,
      dms.length
        ? h(
            "ul",
            {},
            dms.map((r) => roomRow(r, "dms", live)),
          )
        : null,
    ]);
    nav.replaceChildren(main, direct, collapsible("hidden", "Hidden", hidden, live), collapsible("archived", "Archived", archived, live));
    if (focused?.isConnected && document.activeElement !== focused) focused.focus();
    for (const key of menus.keys()) if (!live.has(key)) menus.delete(key);
  }

  function newRoomForm(): typeof newRoom {
    const inputId = `${id}-name`;
    const errId = `${inputId}-error`;
    const err = h("p", { id: errId, class: "field-error" });
    const input = h("input", {
      id: inputId,
      name: "name",
      required: true,
      // No `maxlength`: it counts UTF-16 units (an emoji is 2), the server counts characters. Checked on submit.
      autocomplete: "off",
      placeholder: "room-name",
      "aria-describedby": errId,
    });
    const submit = h("button", { type: "submit" }, "Create");
    const setError = (msg: string) => {
      err.textContent = msg;
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    };
    const form = h(
      "form",
      {
        class: "new-room",
        on: {
          keydown: (e) => {
            if (e.key === "Escape") toggleNewRoom(false);
          },
          submit: async (e) => {
            e.preventDefault();
            if (submit.disabled) return;
            if (textLength(input.value.trim()) > LIMITS.roomName) {
              setError(`Must be no more than ${LIMITS.roomName} characters.`);
              return;
            }
            submit.disabled = true;
            setError("");
            try {
              const room = await actions.create(input.value);
              if (!scope.active) return;
              toggleNewRoom(false);
              navigate(`#/r/${room.id}`);
            } catch (e) {
              if (scope.active) setError(nameError(e));
            } finally {
              submit.disabled = false;
            }
          },
        },
        signal: scope.signal,
      },
      [h("label", { for: inputId, class: "visually-hidden" }, "Room name"), input, submit, err],
    );
    return {
      form,
      input,
      reset() {
        input.value = "";
        setError("");
      },
    };
  }

  return {
    mount(el) {
      root = el;
      scope = createScope();
      menus.clear();
      search = null;
      creating = false;
      newRoom = newRoomForm();
      shell.replaceChildren(alert, nav);
      clear(root);
      root.append(shell);

      scope.defer(
        store.subscribe((s, prev) => {
          if (s.roomsStatus !== prev.roomsStatus) renderAlert();
          if (
            s.rooms !== prev.rooms ||
            s.hidden !== prev.hidden ||
            s.unread !== prev.unread ||
            s.activeRoomId !== prev.activeRoomId ||
            s.user !== prev.user ||
            s.roomsStatus !== prev.roomsStatus
          )
            render();
        }),
      );
      renderAlert();
      render();
    },
    unmount() {
      scope.dispose();
      clear(root);
    },
  };
}
