// Room list (§7.1): Rooms / Hidden / Archived sections, new-room form, per-room actions, live updates.

import { ApiError, type Api } from "../api.ts";
import { clear, h } from "../dom.ts";
import type { Room } from "../lib/types.ts";
import type { View } from "../router.ts";
import { roomSections, type AppState, type Store } from "../store.ts";

type Section = "rooms" | "hidden" | "archived";

export interface RoomsDeps {
  api: Api;
  store: Store<AppState>;
  navigate: (hash: string) => void;
}

let uid = 0;

function nameError(err: unknown): string {
  if (err instanceof ApiError) {
    const msg = err.fields.name;
    if (msg === "Value must be unique.") return "A room with this name already exists.";
    if (msg) return msg;
    if (err.status === 0) return "Can't reach the server. Check your connection.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

export function createRoomsView({ api, store, navigate }: RoomsDeps): View {
  const id = `rooms-${++uid}`;
  let root: HTMLElement;
  let ac: AbortController;
  let active = false;
  let offStore = () => {};
  let offConnect = () => {};
  let subs: Promise<() => Promise<void>>[] = [];

  // UI state that must survive re-renders.
  const open = { hidden: false, archived: false };
  let openMenu: string | null = null;
  let confirming: string | null = null;
  /** Selector to focus after the next render (the elements are rebuilt, so focus is re-applied). */
  let focusAfter: string | null = null;
  const rowSel = (id: string) => `[data-room-id="${id}"]`;
  let loaded = false;

  const alert = h("p", { role: "alert", class: "list-error" });
  const nav = h("nav", { "aria-label": "Rooms" });
  const shell = h("section", { class: "rooms", "aria-busy": "true" });

  // ---- data ----

  const setRoom = (r: Room) => store.set((s) => ({ rooms: new Map(s.rooms).set(r.id, r) }));
  const dropRoom = (roomId: string) =>
    store.set((s) => {
      const rooms = new Map(s.rooms);
      rooms.delete(roomId);
      return { rooms };
    });
  const setHidden = (roomId: string, rowId: string) => store.set((s) => ({ hidden: new Map(s.hidden).set(roomId, rowId) }));
  const dropHiddenRow = (rowId: string) =>
    store.set((s) => ({ hidden: new Map([...s.hidden].filter(([, row]) => row !== rowId)) }));

  async function load() {
    try {
      const [rooms, hidden] = await Promise.all([api.listRooms(), api.listHidden()]);
      if (!active) return;
      loaded = true;
      showError("");
      store.set({ rooms: new Map(rooms.map((r) => [r.id, r])), hidden: new Map(hidden.map((x) => [x.room, x.id])) });
    } catch {
      if (!active) return;
      showError("Couldn't load rooms. Check your connection.", load);
    } finally {
      if (active) shell.setAttribute("aria-busy", "false");
      render();
    }
  }

  function showError(text: string, retry?: () => void) {
    clear(alert);
    if (!text) return;
    alert.append(text);
    if (retry) {
      alert.append(" ", h("button", { type: "button", class: "link", on: { click: () => (showError(""), void retry()) }, signal: ac.signal }, "Retry"));
    }
  }

  async function act(label: string, room: Room, fn: () => Promise<void>) {
    // Picking an action closes the menu; otherwise it would re-render open wherever the room moves to.
    openMenu = null;
    confirming = null;
    render();
    try {
      await fn();
      if (active) showError("");
    } catch {
      if (active) showError(`Couldn't ${label} “${room.name}”. Check your connection and try again.`);
    }
  }

  const hide = (r: Room) => act("hide", r, async () => setHidden(r.id, (await api.hideRoom(r.id)).id));
  const unhide = (r: Room) =>
    act("unhide", r, async () => {
      const rowId = store.get().hidden.get(r.id);
      if (!rowId) return;
      await api.unhideRoom(rowId);
      dropHiddenRow(rowId);
    });
  const setArchived = (r: Room, archived: boolean) =>
    act(archived ? "archive" : "unarchive", r, async () => setRoom(await api.setArchived(r.id, archived)));

  // ---- rendering ----

  function menuItems(r: Room, section: Section): HTMLElement[] {
    const { signal } = ac;
    const mine = r.created_by === store.get().user?.id;
    const btn = (label: string, onClick: () => void, cls = "") =>
      h("button", { type: "button", ...(cls ? { class: cls } : {}), on: { click: onClick }, signal }, label);

    if (confirming === r.id) {
      return [
        h("p", {}, `Archive “${r.name}”? It becomes read-only for everyone.`),
        btn(
          "Archive room",
          () => {
            confirming = null;
            openMenu = null;
            void setArchived(r, true);
          },
          "danger",
        ),
        btn(
          "Cancel",
          () => {
            confirming = null;
            focusAfter = `${rowSel(r.id)} summary`;
            render();
          },
          "cancel",
        ),
      ];
    }
    const items: HTMLElement[] = [];
    if (section === "rooms") items.push(btn("Hide", () => void hide(r)));
    if (section === "hidden") items.push(btn("Unhide", () => void unhide(r)));
    if (mine && section !== "archived")
      items.push(
        btn("Archive", () => {
          confirming = r.id;
          openMenu = r.id;
          focusAfter = `${rowSel(r.id)} .menu-items .cancel`;
          render();
        }),
      );
    if (mine && section === "archived") items.push(btn("Unarchive", () => void setArchived(r, false)));
    return items;
  }

  function roomRow(r: Room, section: Section): HTMLElement {
    const current = store.get().activeRoomId === r.id;
    const items = menuItems(r, section);
    const menu = items.length
      ? h(
          "details",
          {
            class: "menu",
            open: openMenu === r.id,
            on: {
              toggle: (e) => {
                const d = e.currentTarget as HTMLDetailsElement;
                if (d.open) openMenu = r.id;
                else if (openMenu === r.id) (openMenu = null), (confirming = null);
              },
              keydown: (e) => {
                if (e.key !== "Escape" || openMenu !== r.id) return;
                e.preventDefault();
                openMenu = null;
                confirming = null;
                focusAfter = `${rowSel(r.id)} summary`;
                render();
              },
            },
            signal: ac.signal,
          },
          [h("summary", { "aria-label": `Actions for ${r.name}` }, "⋯"), h("div", { class: "menu-items" }, items)],
        )
      : null;
    return h("li", { dataset: { roomId: r.id } }, [
      h("a", { href: `#/r/${r.id}`, "aria-current": current ? "page" : null }, r.name),
      menu,
    ]);
  }

  function collapsible(section: "hidden" | "archived", title: string, rooms: Room[]): HTMLElement {
    return h(
      "details",
      {
        class: "room-section",
        dataset: { section },
        open: open[section],
        on: { toggle: (e) => (open[section] = (e.currentTarget as HTMLDetailsElement).open) },
        signal: ac.signal,
      },
      [h("summary", {}, `${title} (${rooms.length})`), h("ul", {}, rooms.map((r) => roomRow(r, section)))],
    );
  }

  function render() {
    if (!active) return;
    const { rooms, hidden, archived } = roomSections(store.get());
    const main = h("div", { class: "room-section", dataset: { section: "rooms" } }, [
      h("h2", {}, "Rooms"),
      rooms.length
        ? h("ul", {}, rooms.map((r) => roomRow(r, "rooms")))
        : loaded
          ? h("p", { class: "empty" }, "No rooms yet. Create the first one.")
          : null,
    ]);
    nav.replaceChildren(main, collapsible("hidden", "Hidden", hidden), collapsible("archived", "Archived", archived));
    if (focusAfter) {
      nav.querySelector<HTMLElement>(focusAfter)?.focus();
      focusAfter = null;
    }
  }

  function newRoomForm(): HTMLFormElement {
    const inputId = `${id}-name`;
    const errId = `${inputId}-error`;
    const err = h("p", { id: errId, class: "field-error" });
    const input = h("input", {
      id: inputId,
      name: "name",
      required: true,
      maxlength: 48,
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
              const room = await api.createRoom(input.value);
              if (!active) return;
              setRoom(room);
              input.value = "";
              navigate(`#/r/${room.id}`);
            } catch (e) {
              if (active) setError(nameError(e));
            } finally {
              submit.disabled = false;
            }
          },
        },
        signal: ac.signal,
      },
      [h("label", { for: inputId }, "New room"), input, submit, err],
    );
  }

  return {
    mount(el) {
      root = el;
      active = true;
      ac = new AbortController();
      shell.setAttribute("aria-busy", "true");
      shell.replaceChildren(newRoomForm(), alert, nav);
      clear(root);
      root.append(shell);

      offStore = store.subscribe((s, prev) => {
        if (s.rooms !== prev.rooms || s.hidden !== prev.hidden || s.activeRoomId !== prev.activeRoomId || s.user !== prev.user) render();
      });
      subs = [
        api.subscribeRooms((action, r) => {
          if (!active) return;
          if (action === "delete") dropRoom(r.id);
          else setRoom(r);
        }),
        api.subscribeHidden((action, row) => {
          if (!active) return;
          if (action === "delete") dropHiddenRow(row.id);
          else setHidden(row.room, row.id);
        }),
      ];
      offConnect = api.onConnect((reconnect) => {
        if (reconnect && active) void load();
      });
      render();
      void load();
    },
    unmount() {
      active = false;
      ac.abort();
      offStore();
      offConnect();
      for (const p of subs) void p.then((off) => off()).catch(() => {});
      subs = [];
      clear(root);
    },
  };
}
