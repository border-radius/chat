// Room helpers that depend on who is looking (§16.5): a DM is titled after the other member.

import type { Room, User } from "./types.ts";

export const isDm = (room: Room): boolean => room.kind === "dm";

/** The other member of a DM (as expanded by the API), if known. */
export function otherMember(room: Room, me: User | null): User | undefined {
  if (!isDm(room)) return undefined;
  const otherId = room.members?.find((id) => id !== me?.id);
  return room.expand?.members?.find((u) => u.id === otherId) ?? (otherId ? { id: otherId, name: "Unknown" } : undefined);
}

/** What to call a room: "#name" for public rooms, the other member's name for a DM. */
export function roomTitle(room: Room, me: User | null): string {
  return isDm(room) ? (otherMember(room, me)?.name ?? "Unknown") : `#${room.name}`;
}
