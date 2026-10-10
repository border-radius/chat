// The only module that talks to PocketBase (§6). Views depend on the `Api` interface, never on the SDK.

import type PocketBase from "pocketbase";
import { ClientResponseError, type RecordModel } from "pocketbase";
import { PAGE_SIZE, type PageQuery } from "./lib/cursor.ts";
import { createTokenCache } from "./lib/token.ts";
import type { Message, Room, User } from "./lib/types.ts";

export type AvatarSize = 48 | 96;
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
  /** Attachments (§17.4): sent as multipart. */
  files?: File[];
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
  /**
   * Called whenever the stored session changes, including from another tab of the same browser (they share
   * it). Read `currentUser()` to see who is logged in now. Returns an unsubscribe function.
   */
  onAuthChange(fn: () => void): () => void;

  // profile (§15)
  /** Upload a new avatar (already prepared, §15.3). Resolves to the updated user. */
  setAvatar(file: File): Promise<User>;
  removeAvatar(): Promise<User>;
  rename(name: string): Promise<User>;
  /** Thumbnail URL of a user's avatar at `size` px (48 or 96), or "" when they have none. */
  avatarUrl(user: User, size: AvatarSize): string;

  // rooms
  listRooms(signal?: AbortSignal): Promise<Room[]>;
  getRoom(id: string, signal?: AbortSignal): Promise<Room>;
  createRoom(name: string): Promise<Room>;
  setArchived(id: string, archived: boolean): Promise<Room>;

  // direct messages (§16)
  /** The DM with `userId`, created on first use; reopens it if you had closed it. */
  openDm(userId: string): Promise<Room>;
  /** Up to 20 other users whose name contains `query`, by name. */
  searchUsers(query: string, signal?: AbortSignal): Promise<User[]>;

  // hidden rooms
  listHidden(signal?: AbortSignal): Promise<HiddenRow[]>;
  hideRoom(room: string): Promise<HiddenRow>;
  unhideRoom(rowId: string): Promise<void>;

  // messages
  page(q: PageQuery, signal?: AbortSignal): Promise<Message[]>;
  getMessage(id: string, signal?: AbortSignal): Promise<Message>;
  /** Every message matching `q` (not just one page): used for the edits/deletes missed during a disconnect. */
  changes(q: PageQuery, signal?: AbortSignal): Promise<Message[]>;
  send(m: NewMessage): Promise<Message>;
  edit(id: string, text: string): Promise<Message>;
  softDelete(id: string): Promise<Message>;

  // attachments (§17.3)
  /** A fresh file token for protected attachments (cached; one request shared by concurrent callers). */
  fileToken(force?: boolean): Promise<string>;
  /**
   * URL of an attachment (a thumbnail with `thumb`, e.g. "480x360"), signed with the cached file token.
   * Starts a refresh in the background when the token is getting old.
   */
  fileUrl(m: Message, filename: string, thumb?: string): string;

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

/**
 * `codes.auth` of a signUp() rejection whose account *was* created but whose automatic login failed
 * (network, rate limit). Retrying the signup would only fail with "email taken"; the user should log in.
 */
export const SIGNUP_LOGIN_FAILED = "signup_login_failed";

/** A sentence to show for a failed request: network trouble, rate limiting, or the server's own message. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  if (err.status === 0) return "Can't reach the server. Check your connection.";
  // e.g. PocketBase's default `*:auth` limit (2 requests per 3 seconds) or our messages/signup limits
  if (err.status === 429) return "Too many attempts. Wait a few seconds and try again.";
  return err.message;
}

// ---- PocketBase implementation ----

/** Only what the UI renders; never user emails (§6). */
export const MSG_FIELDS =
  "id,room,text,created,updated,edited_at,deleted,files,author,expand.author.id,expand.author.name,expand.author.avatar";
const MSG_OPTS = { expand: "author", fields: MSG_FIELDS } as const;
/** Rooms with their members' public profile (DMs, §16.5); never emails. */
export const ROOM_FIELDS =
  "id,name,archived,created_by,kind,members,last_message_at,created,expand.members.id,expand.members.name,expand.members.avatar";
const ROOM_OPTS = { expand: "members", fields: ROOM_FIELDS } as const;
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

const toUser = (r: RecordModel): User => ({ id: r.id, name: r.name as string, avatar: (r.avatar as string | undefined) ?? "" });
/** What the profile calls return: never the email, even for yourself. */
const USER_FIELDS = "id,name,avatar";

/** SDK list options for a page of messages. `bind` is `pb.filter`: values are bound and escaped, never concatenated. */
export function listOptions(q: PageQuery, bind: (expr: string, params: Record<string, string>) => string) {
  return { filter: bind(q.filter, q.params), sort: q.sort, skipTotal: true, ...MSG_OPTS };
}

/** `{ signal }` when there is one (exactOptionalPropertyTypes: never pass `signal: undefined`). */
const abortable = (signal: AbortSignal | undefined) => (signal ? { signal } : {});

export function createApi(pb: PocketBase): Api {
  pb.autoCancellation(false);
  const users = () => pb.collection("users");
  const rooms = () => pb.collection("rooms");
  const hidden = () => pb.collection("hidden_rooms");
  const messages = () => pb.collection("messages");
  /** Every record event of a collection, narrowed to our Action type. */
  const subscribe = <T>(collection: string, fn: RealtimeHandler<T>, opts: Record<string, unknown>) =>
    wrap(pb.collection(collection).subscribe<T>("*", (e) => fn(e.action as Action, e.record), opts));
  const tokens = createTokenCache(() => wrap(pb.files.getToken()));
  pb.authStore.onChange(() => tokens.reset());
  const me = () => {
    const u = api.currentUser();
    if (!u) throw new ApiError("Not logged in.", 401);
    return u.id;
  };

  const api: Api = {
    currentUser() {
      const r = pb.authStore.record;
      return pb.authStore.isValid && r?.collectionName === "users" ? toUser(r) : null;
    },
    async signUp({ email, password, name }) {
      await wrap(users().create({ email, password, passwordConfirm: password, name }));
      try {
        return await api.logIn(email, password);
      } catch (e) {
        const err = toApiError(e);
        throw new ApiError(err.message, err.status, {}, { auth: SIGNUP_LOGIN_FAILED });
      }
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
    onAuthChange(fn) {
      // The SDK's LocalAuthStore also fires this when another tab saves or clears the shared session.
      return pb.authStore.onChange(() => fn());
    },

    // The SDK sends a body holding a File as multipart, and refreshes the stored auth record from the response.
    setAvatar: async (file) => toUser(await wrap(users().update(me(), { avatar: file }, { fields: USER_FIELDS }))),
    removeAvatar: async () => toUser(await wrap(users().update(me(), { avatar: null }, { fields: USER_FIELDS }))),
    rename: async (name) => toUser(await wrap(users().update(me(), { name }, { fields: USER_FIELDS }))),
    avatarUrl(user, size) {
      if (!user.avatar) return "";
      return pb.files.getURL({ id: user.id, collectionName: "users" } as RecordModel, user.avatar, { thumb: `${size}x${size}` });
    },

    listRooms: (signal) => wrap(rooms().getFullList<Room>({ sort: "name", ...ROOM_OPTS, ...abortable(signal) })),
    getRoom: (id, signal) => wrap(rooms().getOne<Room>(id, { ...ROOM_OPTS, ...abortable(signal) })),
    createRoom: async (name) => wrap(rooms().create<Room>({ name, created_by: me() }, ROOM_OPTS)),
    setArchived: (id, archived) => wrap(rooms().update<Room>(id, { archived }, ROOM_OPTS)),

    openDm: (userId) => wrap(pb.send<Room>("/api/chat/dms", { method: "POST", body: { user: userId } })),
    async searchUsers(query, signal) {
      const opts = {
        filter: pb.filter("name ~ {:q} && id != {:me}", { q: query, me: me() }),
        sort: "name",
        fields: USER_FIELDS,
        skipTotal: true,
        ...abortable(signal),
      };
      return (await wrap(users().getList(1, 20, opts))).items.map(toUser);
    },

    listHidden: (signal) => wrap(hidden().getFullList<HiddenRow>({ fields: HIDDEN_FIELDS, ...abortable(signal) })),
    hideRoom: async (room) => wrap(hidden().create<HiddenRow>({ user: me(), room }, { fields: HIDDEN_FIELDS })),
    unhideRoom: async (rowId) => {
      await wrap(hidden().delete(rowId));
    },

    async page(q, signal) {
      const opts = { ...listOptions(q, pb.filter.bind(pb)), ...abortable(signal) };
      return (await wrap(messages().getList<Message>(1, PAGE_SIZE, opts))).items;
    },
    getMessage: (id, signal) => wrap(messages().getOne<Message>(id, { ...MSG_OPTS, ...abortable(signal) })),
    changes: (q, signal) =>
      wrap(messages().getFullList<Message>({ ...listOptions(q, pb.filter.bind(pb)), batch: 200, ...abortable(signal) })),
    send: async (m) =>
      wrap(
        messages().create<Message>(
          { id: m.id, room: m.room, author: me(), text: m.text, ...(m.files?.length ? { files: m.files } : {}) },
          MSG_OPTS,
        ),
      ),
    edit: (id, text) => wrap(messages().update<Message>(id, { text }, MSG_OPTS)),
    softDelete: (id) => wrap(messages().update<Message>(id, { deleted: true }, MSG_OPTS)),

    fileToken: (force) => tokens.ensure(force),
    fileUrl(m, filename, thumb) {
      if (!tokens.fresh()) void tokens.ensure().catch(() => {});
      const token = tokens.current();
      return pb.files.getURL({ id: m.id, collectionName: "messages" } as RecordModel, filename, {
        ...(token ? { token } : {}),
        ...(thumb ? { thumb } : {}),
      });
    },

    subscribeMessages: (room, fn) => subscribe("messages", fn, { ...MSG_OPTS, filter: pb.filter("room = {:room}", { room }) }),
    subscribeRooms: (fn) => subscribe("rooms", fn, ROOM_OPTS),
    subscribeHidden: (fn) => subscribe("hidden_rooms", fn, { fields: HIDDEN_FIELDS }),

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
