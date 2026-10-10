// Room list (§7.1): Rooms / Hidden / Archived sections, new-room form, per-room actions.
// The data comes from the store, kept live by sync.ts; this view only renders it and issues commands.

import { ApiError, errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { LIMITS } from "../lib/limits.ts";
import type { Room } from "../lib/types.ts";
import type { View } from "../router.ts";
import { createScope, type Scope } from "../scope.ts";
import { roomSections } from "../store.ts";
import { type ActionMenu, createActionMenu, type MenuItem } from "../ui/menu.ts";

type Section = "rooms" | "hidden" | "archived";

function nameError(err: unknown): string {
  if (err instanceof ApiError && err.codes.name === "validation_not_unique") return "A room with this name already exists.";
  if (err instanceof ApiError && err.fields.name) return err.fields.name;
  return errorMessage(err);
}

export function createRoomsView({ store, sync, actions, navigate }: Ctx): View {
  const id = uniqueId("rooms");
  let root: HTMLElement;
  let scope: Scope;

  // UI state that must survive re-renders.
  const open = { hidden: false, archived: false };
  /** Row menus by room id + name, kept across renders so their open/confirm state and focus survive. */
  const menus = new Map<string, ActionMenu>();
  /** The last failed action, shown until the next action or a successful one. */
  let actionError = "";

  const alert = h("p", { role: "alert", class: "list-error" });
  const nav = h("nav", { "aria-label": "Rooms" });
  const shell = h("section", { class: "rooms", "aria-busy": "true" });

  function renderAlert() {
    clear(alert);
    if (store.get().roomsStatus === "error") {
      alert.append(
        "Couldn't load rooms. Check your connection. ",
        h("button", { type: "button", class: "link", on: { click: () => void sync.reload() }, signal: scope.signal }, "Retry"),
      );
    } else {
      alert.append(actionError);
    }
  }

  async function act(label: string, room: Room, fn: () => Promise<void>) {
    try {
      await fn();
      actionError = "";
    } catch {
      actionError = `Couldn't ${label} “${room.name}”. Check your connection and try again.`;
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
    if (section === "rooms") items.push({ label: "Hide", run: () => void hide(r) });
    if (section === "hidden") items.push({ label: "Unhide", run: () => void unhide(r) });
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
    const key = `${r.id}|${r.name}`;
    live.add(key);
    let menu = menus.get(key);
    if (!menu) {
      menu = createActionMenu({ label: `Actions for ${r.name}`, signal: scope.signal });
      menus.set(key, menu);
    }
    menu.update(items);
    return menu.el;
  }

  function roomRow(r: Room, section: Section, live: Set<string>): HTMLElement {
    const current = store.get().activeRoomId === r.id;
    return h("li", { dataset: { roomId: r.id } }, [
      h("a", { href: `#/r/${r.id}`, "aria-current": current ? "page" : null }, r.name),
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
    const { rooms, hidden, archived } = roomSections(s);
    const loading = s.roomsStatus === "idle" || s.roomsStatus === "loading";
    const live = new Set<string>();
    // Rows are rebuilt; the focused control (a menu button, which is kept) gets its focus back below.
    const focused = nav.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    shell.setAttribute("aria-busy", String(loading));
    const main = h("div", { class: "room-section", dataset: { section: "rooms" } }, [
      h("h2", {}, "Rooms"),
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
    nav.replaceChildren(main, collapsible("hidden", "Hidden", hidden, live), collapsible("archived", "Archived", archived, live));
    if (focused?.isConnected && document.activeElement !== focused) focused.focus();
    for (const key of menus.keys()) if (!live.has(key)) menus.delete(key);
  }

  function newRoomForm(): HTMLFormElement {
    const inputId = `${id}-name`;
    const errId = `${inputId}-error`;
    const err = h("p", { id: errId, class: "field-error" });
    const input = h("input", {
      id: inputId,
      name: "name",
      required: true,
      maxlength: LIMITS.roomName,
      autocomplete: "off",
      placeholder: "general",
      "aria-describedby": errId,
    });
    const submit = h("button", { type: "submit" }, "Create");
    const setError = (msg: string) => {
      err.textContent = msg;
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    };
    return h(
      "form",
      {
        class: "new-room",
        on: {
          submit: async (e) => {
            e.preventDefault();
            if (submit.disabled) return;
            submit.disabled = true;
            setError("");
            try {
              const room = await actions.create(input.value);
              if (!scope.active) return;
              input.value = "";
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
      [h("label", { for: inputId }, "New room"), input, submit, err],
    );
  }

  return {
    mount(el) {
      root = el;
      scope = createScope();
      menus.clear();
      shell.replaceChildren(newRoomForm(), alert, nav);
      clear(root);
      root.append(shell);

      scope.defer(
        store.subscribe((s, prev) => {
          if (s.roomsStatus !== prev.roomsStatus) renderAlert();
          if (
            s.rooms !== prev.rooms ||
            s.hidden !== prev.hidden ||
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
