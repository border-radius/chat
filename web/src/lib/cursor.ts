// Keyset pagination over a room's messages, ordered by (created, id) — DESIGN.md §6, §7.5.
// Pure query builders: the caller binds `params` with `pb.filter(filter, params)`, never by concatenation.

export const PAGE_SIZE = 50;

export interface Cursor {
  created: string;
  id: string;
}

export interface PageQuery {
  filter: string;
  params: Record<string, string>;
  /** "-created,-id" pages come back newest-first; "created,id" pages oldest-first. */
  sort: string;
}

const DESC = "-created,-id";
const ASC = "created,id";

/** The newest page of a room (newest-first). */
export function latest(room: string): PageQuery {
  return { filter: "room = {:room}", params: { room }, sort: DESC };
}

/** The oldest page of a room, i.e. "jump to beginning" (oldest-first). */
export function first(room: string): PageQuery {
  return { filter: "room = {:room}", params: { room }, sort: ASC };
}

/** The page just before `c`, the oldest loaded message (newest-first). */
export function older(room: string, c: Cursor): PageQuery {
  return {
    filter: "room = {:room} && (created < {:created} || (created = {:created} && id < {:id}))",
    params: { room, created: c.created, id: c.id },
    sort: DESC,
  };
}

/** The page just after `c`, the newest loaded message (oldest-first). */
export function newer(room: string, c: Cursor): PageQuery {
  return {
    filter: "room = {:room} && (created > {:created} || (created = {:created} && id > {:id}))",
    params: { room, created: c.created, id: c.id },
    sort: ASC,
  };
}
