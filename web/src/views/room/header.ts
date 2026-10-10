// Room header (§7.1, §16.5): back link, room title and the room actions menu (hide, archive, jump to
// beginning). A DM shows the other member's avatar and name, and can be closed but never archived.

import type { RoomActions } from "../../actions.ts";
import { h } from "../../dom.ts";
import { otherMember, roomTitle } from "../../lib/rooms.ts";
import type { Room, User } from "../../lib/types.ts";
import { type AvatarUrl, avatar } from "../../ui/avatar.ts";
import { createActionMenu, type MenuItem } from "../../ui/menu.ts";

export interface RoomHeader {
  readonly el: HTMLElement;
  update(state: { room: Room | undefined; hidden: boolean; me: User | null }): void;
}

export function createRoomHeader(opts: {
  titleId: string;
  actions: RoomActions;
  avatarUrl: AvatarUrl;
  onJumpToBeginning: () => void;
  /** A DM was closed from this menu. */
  onClosed: () => void;
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
  /** What the title shows, to rebuild it only when that changes (the avatar is an image). */
  let shown = "";

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      error.textContent = "";
      return true;
    } catch {
      if (!signal.aborted) error.textContent = "That didn't work. Check your connection and try again.";
      return false;
    }
  }

  function dmItems(room: Room, hidden: boolean): MenuItem[] {
    return [
      hidden
        ? { label: "Reopen conversation", run: () => void act(() => actions.unhide(room.id)) }
        : {
            label: "Close conversation",
            run: () =>
              void act(() => actions.hide(room.id)).then((ok) => {
                if (ok) opts.onClosed();
              }),
          },
      { label: "Jump to beginning", run: opts.onJumpToBeginning },
    ];
  }

  function items(room: Room | undefined, hidden: boolean, mine: boolean): MenuItem[] {
    if (room?.kind === "dm") return dmItems(room, hidden);
    const out: MenuItem[] = [];
    // Hiding an archived room is pointless (it is listed under Archived), but one hidden before it was
    // archived must still be unhidable, or it would silently come back hidden after an unarchive.
    if (room && (!room.archived || hidden)) {
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
    update({ room, hidden, me }) {
      const other = room ? otherMember(room, me) : undefined;
      const text = room ? roomTitle(room, me) : "";
      const key = JSON.stringify([text, other?.avatar ?? null]);
      if (key !== shown) {
        shown = key;
        title.replaceChildren(...(other ? [avatar(other, 24, opts.avatarUrl), h("span", {}, text)] : [text]));
      }
      title.classList.toggle("dm-title", !!other);
      menu.update(items(room, hidden, !!room && room.created_by === me?.id));
    },
  };
}
