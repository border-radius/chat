// Shapes of records as the frontend sees them (DESIGN.md §5, §6).

export interface User {
  id: string;
  name: string;
  /** Avatar filename (§15); "" or absent when the user has none. */
  avatar?: string;
}

export type RoomKind = "public" | "dm";

export interface Room {
  id: string;
  /** "" for a DM: its title is the other member's name (lib/rooms.ts). */
  name: string;
  archived: boolean;
  created_by: string;
  /** Absent = "public" (§16.1). */
  kind?: RoomKind;
  /** A DM's two members; empty for public rooms. */
  members?: string[];
  /** DMs: when the latest message was sent ("" before the first). */
  last_message_at?: string;
  created?: string;
  expand?: { members?: User[] };
}

/** Client-only send state for optimistic messages (§7.5). Absent once the server has the message. */
export type SendStatus = "pending" | "failed";

export interface Message {
  id: string;
  room: string;
  author: string;
  text: string;
  /** PocketBase datetime, e.g. "2026-10-10 12:34:56.789Z". */
  created: string;
  updated: string;
  /** "" when never edited. */
  edited_at: string;
  deleted: boolean;
  /** Stored attachment names (§17.1); empty or absent when there are none. */
  files?: string[];
  expand?: { author?: User };
  status?: SendStatus;
  /** Client-only: attachments of a message not (yet) on the server, with local preview URLs (§17.4). */
  localFiles?: LocalFile[];
}

export interface LocalFile {
  file: File;
  /** Object URL for an image preview, "" for other files. Revoked once the message no longer needs it. */
  url: string;
}
