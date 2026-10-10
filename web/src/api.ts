// The only module that talks to PocketBase (§6). Views depend on the `Api` interface, never on the SDK.

import type PocketBase from "pocketbase";
import { ClientResponseError, type RecordModel } from "pocketbase";
import { MSG_FIELDS, PAGE_SIZE, listOptions, type PageQuery } from "./lib/cursor.ts";
import type { Message, Room, User } from "./lib/types.ts";

export type Unsubscribe = () => Promise<void>;
export type Action = "create" | "update" | "delete";
export type RealtimeHandler<T> = (action: Action, record: T) => void;

export interface HiddenRow {
  id: string;
  room: string;
}

export interface NewMessage {
  /** Client-generated (lib/id.ts) so retries can't duplicate (§7.5). */
  id: string;
  room: string;
  text: string;
}

/**
 * Reads take an optional AbortSignal: views pass their scope's, so leaving a view cancels its pending requests
 * (they then reject with status 0). Writes take none on purpose: a send or edit should still reach the server
 * if the user navigates away while it is in flight.
 */
export interface Api {
  // auth
  currentUser(): User | null;
  signUp(input: { email: string; password: string; name: string }): Promise<User>;
  logIn(email: string, password: string): Promise<User>;
  /** Re-validate the stored session with the server. Rejects when it is no longer valid. */
  refreshAuth(): Promise<User>;
  logOut(): void;

  // rooms
  listRooms(signal?: AbortSignal): Promise<Room[]>;
  getRoom(id: string, signal?: AbortSignal): Promise<Room>;
  createRoom(name: string): Promise<Room>;
  setArchived(id: string, archived: boolean): Promise<Room>;

  // hidden rooms
  listHidden(signal?: AbortSignal): Promise<HiddenRow[]>;
  hideRoom(room: string): Promise<HiddenRow>;
  unhideRoom(rowId: string): Promise<void>;

  // messages
  page(q: PageQuery, signal?: AbortSignal): Promise<Message[]>;
  getMessage(id: string, signal?: AbortSignal): Promise<Message>;
  send(m: NewMessage): Promise<Message>;
  edit(id: string, text: string): Promise<Message>;
  softDelete(id: string): Promise<Message>;

  // realtime
  subscribeMessages(room: string, fn: RealtimeHandler<Message>): Promise<Unsubscribe>;
  subscribeRooms(fn: RealtimeHandler<Room>): Promise<Unsubscribe>;
  subscribeHidden(fn: RealtimeHandler<HiddenRow>): Promise<Unsubscribe>;
  /** Called on every realtime (re)connect; `reconnect` is false for the first one. */
  onConnect(fn: (reconnect: boolean) => void): () => void;
  unsubscribeAll(): Promise<void>;
}

/** Normalized error so views never depend on SDK error classes. */
export class ApiError extends Error {
  readonly status: number;
  /** Per-field validation messages, e.g. { email: "Must be a valid email." } */
  readonly fields: Record<string, string>;
  /** Per-field validation codes, e.g. { name: "validation_not_unique" }. Match on these, not on messages. */
  readonly codes: Record<string, string>;

  constructor(message: string, status: number, fields: Record<string, string> = {}, codes: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fields = fields;
    this.codes = codes;
  }
}

/** A sentence to show for a failed request: network trouble, rate limiting, or the server's own message. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  if (err.status === 0) return "Can't reach the server. Check your connection.";
  // e.g. PocketBase's default `*:auth` limit (2 requests per 3 seconds) or our messages/signup limits
  if (err.status === 429) return "Too many attempts. Wait a few seconds and try again.";
  return err.message;
}

// ---- PocketBase implementation ----

const ROOM_FIELDS = "id,name,archived,created_by";
const HIDDEN_FIELDS = "id,room";

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ClientResponseError) {
    const data = (e.response?.data ?? {}) as Record<string, { message?: unknown; code?: unknown }>;
    const pick = (key: "message" | "code") =>
      Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v && typeof v[key] === "string")
          .map(([k, v]) => [k, v[key] as string]),
      );
    const message = (e.response?.message as string | undefined) || e.message;
    return new ApiError(message, e.isAbort ? 0 : e.status, pick("message"), pick("code"));
  }
  return new ApiError(e instanceof Error ? e.message : String(e), 0);
}

async function wrap<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw toApiError(e);
  }
}

const toUser = (r: RecordModel): User => ({ id: r.id, name: r.name as string });

/** `{ signal }` when there is one (exactOptionalPropertyTypes: never pass `signal: undefined`). */
const abortable = (signal: AbortSignal | undefined) => (signal ? { signal } : {});

export function createApi(pb: PocketBase): Api {
  pb.autoCancellation(false);
  const users = () => pb.collection("users");
  const rooms = () => pb.collection("rooms");
  const hidden = () => pb.collection("hidden_rooms");
  const messages = () => pb.collection("messages");
  const me = () => {
    const u = api.currentUser();
    if (!u) throw new ApiError("Not logged in.", 401);
    return u.id;
  };
  const msgOpts = { expand: "author", fields: MSG_FIELDS };

  const api: Api = {
    currentUser() {
      const r = pb.authStore.record;
      return pb.authStore.isValid && r?.collectionName === "users" ? toUser(r) : null;
    },
    async signUp({ email, password, name }) {
      await wrap(users().create({ email, password, passwordConfirm: password, name }));
      return api.logIn(email, password);
    },
    async logIn(email, password) {
      return toUser((await wrap(users().authWithPassword(email, password))).record);
    },
    async refreshAuth() {
      if (!api.currentUser()) throw new ApiError("Not logged in.", 401);
      return toUser((await wrap(users().authRefresh())).record);
    },
    logOut() {
      pb.authStore.clear();
    },

    listRooms: (signal) => wrap(rooms().getFullList<Room>({ sort: "name", fields: ROOM_FIELDS, ...abortable(signal) })),
    getRoom: (id, signal) => wrap(rooms().getOne<Room>(id, { fields: ROOM_FIELDS, ...abortable(signal) })),
    createRoom: async (name) => wrap(rooms().create<Room>({ name, created_by: me() }, { fields: ROOM_FIELDS })),
    setArchived: (id, archived) => wrap(rooms().update<Room>(id, { archived }, { fields: ROOM_FIELDS })),

    listHidden: (signal) => wrap(hidden().getFullList<HiddenRow>({ fields: HIDDEN_FIELDS, ...abortable(signal) })),
    hideRoom: async (room) => wrap(hidden().create<HiddenRow>({ user: me(), room }, { fields: HIDDEN_FIELDS })),
    unhideRoom: async (rowId) => {
      await wrap(hidden().delete(rowId));
    },

    async page(q, signal) {
      const opts = { ...listOptions(q, pb.filter.bind(pb)), ...abortable(signal) };
      return (await wrap(messages().getList<Message>(1, PAGE_SIZE, opts))).items;
    },
    getMessage: (id, signal) => wrap(messages().getOne<Message>(id, { ...msgOpts, ...abortable(signal) })),
    send: async (m) => wrap(messages().create<Message>({ id: m.id, room: m.room, author: me(), text: m.text }, msgOpts)),
    edit: (id, text) => wrap(messages().update<Message>(id, { text }, msgOpts)),
    softDelete: (id) => wrap(messages().update<Message>(id, { deleted: true }, msgOpts)),

    subscribeMessages: (room, fn) =>
      wrap(
        messages().subscribe<Message>("*", (e) => fn(e.action as Action, e.record), {
          ...msgOpts,
          filter: pb.filter("room = {:room}", { room }),
        }),
      ),
    subscribeRooms: (fn) => wrap(rooms().subscribe<Room>("*", (e) => fn(e.action as Action, e.record), { fields: ROOM_FIELDS })),
    subscribeHidden: (fn) =>
      wrap(hidden().subscribe<HiddenRow>("*", (e) => fn(e.action as Action, e.record), { fields: HIDDEN_FIELDS })),

    onConnect(fn) {
      // PB_CONNECT only reaches listeners for connections made after they subscribe. If we are already
      // connected now, the next PB_CONNECT this listener sees is a reconnect, not the initial connect.
      let connected = pb.realtime.isConnected;
      const unsub = pb.realtime.subscribe("PB_CONNECT", () => {
        fn(connected);
        connected = true;
      });
      return () => void unsub.then((off) => off()).catch(() => {});
    },
    unsubscribeAll: () => wrap(pb.realtime.unsubscribe()),
  };
  return api;
}
