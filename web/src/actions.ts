// Room commands shared by the room list and the room header: call the server, then update the store.
// They reject with ApiError; showing the failure is up to the caller.

import type { Api } from "./api.ts";
import type { Room } from "./lib/types.ts";
import { type AppState, markHidden, type Store, unmarkHidden, unmarkHiddenRoom, upsertRoom } from "./store.ts";

export interface RoomActions {
  create(name: string): Promise<Room>;
  hide(roomId: string): Promise<void>;
  unhide(roomId: string): Promise<void>;
  setArchived(roomId: string, archived: boolean): Promise<void>;
  /** Open (or reopen) the DM with `userId` (§16.2). Resolves to the room, now in the store. */
  openDm(userId: string): Promise<Room>;
}

export function createRoomActions({ api, store }: { api: Api; store: Store<AppState> }): RoomActions {
  return {
    async create(name) {
      const room = await api.createRoom(name);
      store.set(upsertRoom(room));
      return room;
    },
    async hide(roomId) {
      const row = await api.hideRoom(roomId);
      store.set(markHidden(roomId, row.id));
    },
    async unhide(roomId) {
      const rowId = store.get().hidden.get(roomId);
      if (!rowId) return;
      await api.unhideRoom(rowId);
      store.set(unmarkHidden(rowId));
    },
    async setArchived(roomId, archived) {
      store.set(upsertRoom(await api.setArchived(roomId, archived)));
    },
    async openDm(userId) {
      // Already open: no request (the route is rate limited per IP, which a whole office may share; QA BUG-30).
      const { rooms, hidden, user } = store.get();
      for (const r of rooms.values()) {
        if (r.kind === "dm" && r.members?.includes(userId) && r.members.includes(user?.id ?? "") && !hidden.has(r.id)) return r;
      }
      const room = await api.openDm(userId);
      store.set(upsertRoom(room));
      store.set(unmarkHiddenRoom(room.id));
      return room;
    },
  };
}
