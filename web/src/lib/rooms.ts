// Room helpers that depend on who is looking (§16.5): a DM is titled after the other member.

import type { Room, User, Visibility } from "./types.ts";

export const isDm = (room: Room): boolean => room.kind === "dm";

/** Who can see the room (§23.1); rooms from before visibility existed are public. */
export const visibilityOf = (room: Room): Visibility => room.visibility ?? "public";

/** How each visibility is called and explained (§23.1). */
export const VISIBILITY: Record<Visibility, { label: string; icon: string; hint: string }> = {
  private: { label: "Private", icon: "🔒", hint: "Only the people you add can read and post." },
  public: { label: "Public", icon: "#", hint: "Everyone with an account can read and post." },
  open: {
    label: "Open Air",
    icon: "🌐",
    hint: "Anyone can read it, even without an account. Everyone with an account can post.",
  },
};

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
