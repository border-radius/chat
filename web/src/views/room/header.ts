// Room header (§7.1): back link, room name and the room actions menu (hide, archive, jump to beginning).

import type { RoomActions } from "../../actions.ts";
import { h } from "../../dom.ts";
import type { Room } from "../../lib/types.ts";
import { createActionMenu, type MenuItem } from "../../ui/menu.ts";

export interface RoomHeader {
  readonly el: HTMLElement;
  update(state: { room: Room | undefined; hidden: boolean; mine: boolean }): void;
}

export function createRoomHeader(opts: {
  titleId: string;
  actions: RoomActions;
  onJumpToBeginning: () => void;
  signal: AbortSignal;
}): RoomHeader {
  const { actions, signal } = opts;
  const title = h("h1", { id: opts.titleId });
  const error = h("p", { class: "room-error", role: "alert" });
  const menu = createActionMenu({ label: "Room actions", signal });
  const el = h("header", { class: "room-header" }, [
    h("a", { href: "#/", class: "back", "aria-label": "Back to rooms" }, "← Rooms"),
    title,
    menu.el,
    error,
  ]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      error.textContent = "";
    } catch {
      if (!signal.aborted) error.textContent = "That didn't work. Check your connection and try again.";
    }
  }

  function items(room: Room | undefined, hidden: boolean, mine: boolean): MenuItem[] {
    const out: MenuItem[] = [];
    if (room && !room.archived) {
      out.push(
        hidden
          ? { label: "Unhide room", run: () => void act(() => actions.unhide(room.id)) }
          : { label: "Hide room", run: () => void act(() => actions.hide(room.id)) },
      );
    }
    if (room && mine) {
      out.push(
        room.archived
          ? { label: "Unarchive room", run: () => void act(() => actions.setArchived(room.id, false)) }
          : {
              label: "Archive room",
              confirm: { text: `Archive “${room.name}”? It becomes read-only for everyone.`, action: "Archive" },
              run: () => void act(() => actions.setArchived(room.id, true)),
            },
      );
    }
    out.push({ label: "Jump to beginning", run: opts.onJumpToBeginning });
    return out;
  }

  return {
    el,
    update({ room, hidden, mine }) {
      title.textContent = room ? `#${room.name}` : "";
      menu.update(items(room, hidden, mine));
    },
  };
}
