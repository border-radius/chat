// Room header (§7.1, §16.5): back link, room title, the search (§29) and media (§30) buttons and the room actions menu (hide, archive, room access, jump to
// beginning). A DM shows the other member's avatar and name, and can be closed but never archived. A private or Open
// Air room says so next to its name (§23.1); a guest only gets "Jump to beginning" (§23.3).

import type { RoomActions } from "../../actions.ts";
import { errorMessage } from "../../api.ts";
import { h } from "../../dom.ts";
import { otherMember, roomTitle, VISIBILITY, visibilityOf } from "../../lib/rooms.ts";
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
  /** Search the room's messages (§29). */
  onSearch: () => void;
  /** Show the room's images and videos as a grid (§30). */
  onMedia: () => void;
  /** "Room access…" (the creator) or "Members" (the others, in a private room): open the access dialog (§23.2). */
  onAccess: () => void;
  /** A DM was closed from this menu. */
  onClosed: () => void;
  signal: AbortSignal;
}): RoomHeader {
  const { actions, signal } = opts;
  const title = h("h1", { id: opts.titleId });
  const error = h("p", { class: "room-error", role: "alert" });
  const menu = createActionMenu({ label: "Room actions", signal });
  const search = h(
    "button",
    {
      type: "button",
      class: "search-toggle",
      "aria-label": "Search messages",
      title: "Search messages",
      on: { click: opts.onSearch },
      signal,
    },
    "🔍",
  );
  // Looks like the search button (its class), which comes first: closing search focuses `.search-toggle`.
  const media = h(
    "button",
    { type: "button", class: "search-toggle", "aria-label": "Media", title: "Media", on: { click: opts.onMedia }, signal },
    "🖼️",
  );
  const el = h("header", { class: "room-header" }, [
    h("a", { href: "/", class: "back", "aria-label": "Back to rooms" }, "← Rooms"),
    title,
    search,
    media,
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
    } catch (e) {
      // Say why: network trouble, rate limiting or the server's reason (QA BUG-39).
      if (!signal.aborted) error.textContent = `That didn't work. ${errorMessage(e)}`;
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

  function items(room: Room | undefined, hidden: boolean, mine: boolean, guest: boolean): MenuItem[] {
    if (room?.kind === "dm") return dmItems(room, hidden);
    const out: MenuItem[] = [];
    if (guest) return [{ label: "Jump to beginning", run: opts.onJumpToBeginning }];
    if (room && (mine || visibilityOf(room) === "private")) {
      out.push({ label: mine ? "Room access…" : `Members (${room.members?.length ?? 0})`, run: opts.onAccess });
    }
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
      const vis = room && !other ? visibilityOf(room) : "public";
      const key = JSON.stringify([text, other?.avatar ?? null, vis]);
      if (key !== shown) {
        shown = key;
        const badge =
          vis === "public"
            ? null
            : h("span", { class: `vis-badge vis-${vis}`, title: VISIBILITY[vis].hint }, `${VISIBILITY[vis].icon} ${VISIBILITY[vis].label}`);
        title.replaceChildren(...(other ? [avatar(other, 24, opts.avatarUrl), h("span", {}, text)] : [text, badge ?? ""]));
      }
      title.classList.toggle("dm-title", !!other);
      menu.update(items(room, hidden, !!room && room.created_by === me?.id, !me));
    },
  };
}
