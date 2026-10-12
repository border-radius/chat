// The only module that talks to PocketBase (§6). Views depend on the `Api` interface, never on the client.

import { PAGE_SIZE, type PageQuery } from "./lib/cursor.ts";
import { createTokenCache } from "./lib/token.ts";
import type { Message, Room, User, Visibility } from "./lib/types.ts";
import { type AuthRecord, type PbClient, PbError, type Query, type RequestOptions } from "./pb.ts";

export type AvatarSize = 48 | 96;
export type Unsubscribe = () => Promise<void>;
export type Action = "create" | "update" | "delete";
export type RealtimeHandler<T> = (action: Action, record: T) => void;

export interface HiddenRow {
  id: string;
  room: string;
}

/** A room_reads row (§18.1): only which room it is about matters to the client. */
export type ReadRow = HiddenRow;

/** Unread messages per room id (rooms without any are left out), as of `at` (server time, §18.2). */
export interface UnreadCounts {
  at: string;
  rooms: Record<string, number>;
}

/** What the unread counter needs to know about a message event in any room (§18.3). */
export type MessageActivity = Pick<Message, "id" | "room" | "author" | "created" | "deleted">;

export interface NewMessage {
  /** Client-generated (lib/id.ts) so retries can't duplicate (§7.5). */
  id: string;
  room: string;
  text: string;
  /** Attachments (§17.4): sent as multipart. */
  files?: File[];
  /** The message this one replies to (§19). */
  replyTo?: string;
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
  /** Re-validate the stored session with the server, which renews it. Rejects when it is no longer valid. */
  refreshAuth(): Promise<User>;
  /** When the stored session expires (epoch ms), or 0 without one. */
  sessionExpiry(): number;
  logOut(): void;
  /**
   * Called whenever the stored session changes, including from another tab of the same browser (they share
   * it). Read `currentUser()` to see who is logged in now. Returns an unsubscribe function.
   */
  onAuthChange(fn: () => void): () => void;
  /**
   * Called when the server refuses a change sent with the session (400, 401, 403 or 404). Often a plain mistake, but
   * also what a session revoked elsewhere gets (a password change signs out every other device), which only checking
   * the session can tell. Returns an unsubscribe function.
   */
  onRejected(fn: () => void): () => void;

  // profile (§15)
  /** Upload a new avatar (already prepared, §15.3). Resolves to the updated user. */
  setAvatar(file: File): Promise<User>;
  removeAvatar(): Promise<User>;
  rename(name: string): Promise<User>;
  /**
   * Change your password (§22.2). The server checks the current one and signs out every other session; this one gets
   * a fresh token. Rejects with field errors on `oldPassword` or `password`.
   */
  changePassword(oldPassword: string, password: string): Promise<User>;
  /** Thumbnail URL of a user's avatar at `size` px (48 or 96), or "" when they have none. */
  avatarUrl(user: User, size: AvatarSize): string;

  // rooms
  listRooms(signal?: AbortSignal): Promise<Room[]>;
  getRoom(id: string, signal?: AbortSignal): Promise<Room>;
  createRoom(name: string, visibility?: Visibility): Promise<Room>;
  setArchived(id: string, archived: boolean): Promise<Room>;
  /**
   * Who can see the room (§23.2): its visibility, and for a private room its members (user ids; the creator is always
   * one). Only the creator may. Resolves to the room as saved.
   */
  setAccess(id: string, visibility: Visibility, members: readonly string[]): Promise<Room>;

  // direct messages (§16)
  /** The DM with `userId`, created on first use; reopens it if you had closed it. */
  openDm(userId: string): Promise<Room>;
  /** Up to 20 other users whose name contains `query` (ignoring case, as names are compared), by name. */
  searchUsers(query: string, signal?: AbortSignal): Promise<User[]>;
  /** The users with these ids (at most 50), e.g. to name who reacted (§20.3). Unknown ids are left out. */
  usersById(ids: readonly string[], signal?: AbortSignal): Promise<User[]>;

  // hidden rooms
  listHidden(signal?: AbortSignal): Promise<HiddenRow[]>;
  hideRoom(room: string): Promise<HiddenRow>;
  unhideRoom(rowId: string): Promise<void>;

  // unread counts (§18)
  /** Unread messages per room, at most 100 each. */
  unreadCounts(signal?: AbortSignal): Promise<UnreadCounts>;
  /** You have read `room` up to `at` (a message's `created`). The server never moves it back. */
  markRead(room: string, at: string): Promise<void>;

  // messages
  page(q: PageQuery, signal?: AbortSignal): Promise<Message[]>;
  getMessage(id: string, signal?: AbortSignal): Promise<Message>;
  /** Every message matching `q` (not just one page): used for the edits/deletes missed during a disconnect. */
  changes(q: PageQuery, signal?: AbortSignal): Promise<Message[]>;
  send(m: NewMessage): Promise<Message>;
  edit(id: string, text: string): Promise<Message>;
  softDelete(id: string): Promise<Message>;
  /** Add (`on`) or remove your `emoji` reaction on a message (§20). Idempotent. */
  react(id: string, emoji: string, on: boolean): Promise<Message>;
  /** Soft-delete several of your messages at once, all or none (§21.2). Resolves to them, deleted. */
  deleteMany(ids: readonly string[]): Promise<Message[]>;
  /** Copy messages into `room` as yours, saying who first wrote them, all or none (§21.3). Resolves to the copies. */
  forward(ids: readonly string[], room: string): Promise<Message[]>;

  // attachments (§17.3)
  /**
   * A fresh file token for protected attachments (cached; one request shared by concurrent callers). "" without a
   * session: a guest reads Open Air rooms' attachments without one (§23.3).
   */
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
  /** Every message event in every room you can see, without text or files (§18.3). */
  subscribeAllMessages(fn: RealtimeHandler<MessageActivity>): Promise<Unsubscribe>;
  /** Your own room_reads rows, e.g. written by another tab or device. */
  subscribeReads(fn: RealtimeHandler<ReadRow>): Promise<Unsubscribe>;
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
  "id,room,text,created,updated,edited_at,deleted,files,file_names,reactions,author,expand.author.id,expand.author.name,expand.author.avatar," +
  "reply_to,expand.reply_to.id,expand.reply_to.author,expand.reply_to.text,expand.reply_to.deleted,expand.reply_to.files," +
  "expand.reply_to.expand.author.id,expand.reply_to.expand.author.name," +
  "forwarded_from,expand.forwarded_from.id,expand.forwarded_from.name";
const MSG_OPTS = { expand: "author,reply_to.author,forwarded_from", fields: MSG_FIELDS } as const;
/** Rooms with their members' public profile (DMs, §16.5); never emails. */
export const ROOM_FIELDS =
  "id,name,archived,created_by,kind,visibility,members,last_message_at,created,expand.members.id,expand.members.name,expand.members.avatar";
const ROOM_OPTS = { expand: "members", fields: ROOM_FIELDS } as const;
const HIDDEN_FIELDS = "id,room";
const ACTIVITY_FIELDS = "id,room,author,created,deleted";

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof PbError) {
    const data = e.response.data ?? {};
    const pick = (key: "message" | "code") =>
      Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v && typeof v[key] === "string")
          .map(([k, v]) => [k, v[key] as string]),
      );
    return new ApiError(e.message, e.status, pick("message"), pick("code"));
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

const toUser = (r: AuthRecord): User => ({ id: r.id, name: r.name as string, avatar: (r.avatar as string | undefined) ?? "" });
/** What the profile calls return: never the email, even for yourself. */
const USER_FIELDS = "id,name,avatar";

/** Query for a page of messages. `bind` is `pb.filter`: values are bound and escaped, never concatenated. */
export function listOptions(q: PageQuery, bind: (expr: string, params: Record<string, string>) => string) {
  return { filter: bind(q.filter, q.params), sort: q.sort, skipTotal: true, ...MSG_OPTS };
}

/** Record endpoints of one collection: the part of the SDK's RecordService we use. */
function records(pb: PbClient, collection: string) {
  const path = `/api/collections/${collection}`;
  const one = (id: string) => `${path}/records/${encodeURIComponent(id)}`;
  const list = <T>(page: number, perPage: number, query: Query, signal?: AbortSignal) =>
    pb.send<{ items: T[] }>(`${path}/records`, { query: { page, perPage, ...query }, signal });
  /** Save a fresh auth response, as the SDK does. */
  const auth = async (p: Promise<{ token: string; record: AuthRecord }>) => {
    const { token, record } = await p;
    pb.authStore.save(token, record);
    return record;
  };
  return {
    list,
    /** Every page, `batch` records at a time. */
    async fullList<T>(query: Query, signal?: AbortSignal, batch = 1000): Promise<T[]> {
      const out: T[] = [];
      for (let page = 1; ; page++) {
        const { items } = await list<T>(page, batch, { skipTotal: true, ...query }, signal);
        out.push(...items);
        if (items.length < batch) return out;
      }
    },
    get: <T>(id: string, query: Query, signal?: AbortSignal) => pb.send<T>(one(id), { query, signal }),
    create: <T>(body: Record<string, unknown>, query?: Query) => pb.send<T>(`${path}/records`, { method: "POST", body, query }),
    async update<T>(id: string, body: Record<string, unknown>, query: Query): Promise<T> {
      const item = await pb.send<AuthRecord>(one(id), { method: "PATCH", body, query });
      // Updating the logged-in user refreshes the stored record (other tabs and onAuthChange see it).
      const r = pb.authStore.record;
      if (r?.id === item.id && r.collectionName === collection) pb.authStore.save(pb.authStore.token, { ...r, ...item });
      return item as T;
    },
    delete: (id: string) => pb.send(one(id), { method: "DELETE" }),
    authWithPassword: (identity: string, password: string) =>
      auth(pb.send(`${path}/auth-with-password`, { method: "POST", body: { identity, password } })),
    authRefresh: () => auth(pb.send(`${path}/auth-refresh`, { method: "POST" })),
    /** A custom route that answers like a login. */
    authAt: (url: string, body: Record<string, unknown>) => auth(pb.send(url, { method: "POST", body })),
  };
}

/** Statuses of a refused change: invalid data, or no (valid) session. */
const REFUSED = new Set([400, 401, 403, 404]);

export function createApi(client: PbClient): Api {
  const rejected = new Set<() => void>();
  /** The client, telling onRejected listeners about changes refused while the session was sent with them. */
  const pb: PbClient = {
    authStore: client.authStore,
    realtime: client.realtime,
    filter: client.filter,
    fileUrl: client.fileUrl,
    async send<T>(path: string, opts: RequestOptions = {}): Promise<T> {
      const token = client.authStore.token;
      try {
        return await client.send<T>(path, opts);
      } catch (e) {
        const write = (opts.method ?? "GET") !== "GET" && !path.includes("/auth-"); // a login or refresh says so itself
        if (e instanceof PbError && REFUSED.has(e.status) && write && token && token === client.authStore.token) {
          for (const fn of [...rejected]) fn();
        }
        throw e;
      }
    },
  };
  const users = records(pb, "users");
  const rooms = records(pb, "rooms");
  const hidden = records(pb, "hidden_rooms");
  const messages = records(pb, "messages");
  /** Every record event of a collection, narrowed to our Action type. */
  const subscribe = <T>(collection: string, fn: RealtimeHandler<T>, query: Query) =>
    wrap(
      pb.realtime.subscribe(
        `${collection}/*`,
        (e) => {
          const { action, record } = e as { action: Action; record: T };
          fn(action, record);
        },
        query,
      ),
    );
  const tokens = createTokenCache(() =>
    wrap(pb.send<{ token?: string }>("/api/files/token", { method: "POST" })).then((d) => d.token || ""),
  );
  // A file token belongs to a user: drop it when the user changes, but not on a session refresh of the same user
  // (every page load does one, often while the first token request is in flight: QA BUG-25).
  const sessionUser = () => (pb.authStore.isValid ? (pb.authStore.record?.id ?? "") : "");
  let tokenUser = sessionUser();
  pb.authStore.onChange(() => {
    if (sessionUser() === tokenUser) return;
    tokenUser = sessionUser();
    tokens.reset();
  });
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
      await wrap(users.create({ email, password, passwordConfirm: password, name }));
      try {
        return await api.logIn(email, password);
      } catch (e) {
        const err = toApiError(e);
        throw new ApiError(err.message, err.status, {}, { auth: SIGNUP_LOGIN_FAILED });
      }
    },
    async logIn(email, password) {
      return toUser(await wrap(users.authWithPassword(email, password)));
    },
    async refreshAuth() {
      if (!api.currentUser()) throw new ApiError("Not logged in.", 401);
      return toUser(await wrap(users.authRefresh()));
    },
    sessionExpiry: () => pb.authStore.expiresAt,
    logOut() {
      pb.authStore.clear();
    },
    onAuthChange(fn) {
      // A localStorage-backed store also fires this when another tab saves or clears the shared session.
      return pb.authStore.onChange(() => fn());
    },
    onRejected(fn) {
      rejected.add(fn);
      return () => void rejected.delete(fn);
    },

    // A body holding a File is sent as multipart; update() refreshes the stored auth record from the response.
    setAvatar: async (file) => toUser(await wrap(users.update(me(), { avatar: file }, { fields: USER_FIELDS }))),
    removeAvatar: async () => toUser(await wrap(users.update(me(), { avatar: null }, { fields: USER_FIELDS }))),
    rename: async (name) => toUser(await wrap(users.update(me(), { name }, { fields: USER_FIELDS }))),
    async changePassword(oldPassword, password) {
      me();
      return toUser(await wrap(users.authAt("/api/chat/password", { oldPassword, password })));
    },
    avatarUrl(user, size) {
      if (!user.avatar) return "";
      return pb.fileUrl("users", user.id, user.avatar, { thumb: `${size}x${size}` });
    },

    listRooms: (signal) => wrap(rooms.fullList<Room>({ sort: "name", ...ROOM_OPTS }, signal)),
    getRoom: (id, signal) => wrap(rooms.get<Room>(id, ROOM_OPTS, signal)),
    createRoom: async (name, visibility) =>
      wrap(rooms.create<Room>({ name, created_by: me(), ...(visibility ? { visibility } : {}) }, ROOM_OPTS)),
    setArchived: (id, archived) => wrap(rooms.update<Room>(id, { archived }, ROOM_OPTS)),
    setAccess: (id, visibility, members) =>
      wrap(rooms.update<Room>(id, { visibility, members: visibility === "private" ? [...members] : [] }, ROOM_OPTS)),

    openDm: (userId) => wrap(pb.send<Room>("/api/chat/dms", { method: "POST", body: { user: userId } })),
    async searchUsers(query, signal) {
      me();
      // A route, not a filter on `name`: it matches case-insensitively beyond ASCII ("иван" finds "Иван", QA BUG-55).
      return (await wrap(pb.send<AuthRecord[]>("/api/chat/users", { query: { q: query }, signal }))).map(toUser);
    },

    async usersById(ids, signal) {
      const some = ids.slice(0, 50);
      if (!some.length) return [];
      const params = Object.fromEntries(some.map((id, i) => [`u${i}`, id]));
      const opts = { filter: pb.filter(some.map((_, i) => `id = {:u${i}}`).join(" || "), params), fields: USER_FIELDS, skipTotal: true };
      return (await wrap(users.list<AuthRecord>(1, some.length, opts, signal))).items.map(toUser);
    },

    listHidden: (signal) => wrap(hidden.fullList<HiddenRow>({ fields: HIDDEN_FIELDS }, signal)),
    hideRoom: async (room) => wrap(hidden.create<HiddenRow>({ user: me(), room }, { fields: HIDDEN_FIELDS })),
    unhideRoom: async (rowId) => {
      await wrap(hidden.delete(rowId));
    },

    unreadCounts: (signal) => wrap(pb.send<UnreadCounts>("/api/chat/unread", { signal })),
    markRead: async (room, at) => {
      await wrap(pb.send("/api/chat/reads", { method: "POST", body: { room, at } }));
    },

    async page(q, signal) {
      return (await wrap(messages.list<Message>(1, PAGE_SIZE, listOptions(q, pb.filter), signal))).items;
    },
    getMessage: (id, signal) => wrap(messages.get<Message>(id, MSG_OPTS, signal)),
    changes: (q, signal) => wrap(messages.fullList<Message>(listOptions(q, pb.filter), signal, 200)),
    send: async (m) =>
      wrap(
        messages.create<Message>(
          {
            id: m.id,
            room: m.room,
            author: me(),
            text: m.text,
            ...(m.files?.length ? { files: m.files } : {}),
            ...(m.replyTo ? { reply_to: m.replyTo } : {}),
          },
          MSG_OPTS,
        ),
      ),
    edit: (id, text) => wrap(messages.update<Message>(id, { text }, MSG_OPTS)),
    softDelete: (id) => wrap(messages.update<Message>(id, { deleted: true }, MSG_OPTS)),
    react: (id, emoji, on) =>
      wrap(pb.send<Message>("/api/chat/reactions", { method: "POST", body: { message: id, emoji, on }, query: MSG_OPTS })),

    deleteMany: (ids) => wrap(pb.send<Message[]>("/api/chat/delete", { method: "POST", body: { messages: ids }, query: MSG_OPTS })),
    forward: (ids, room) =>
      wrap(pb.send<Message[]>("/api/chat/forward", { method: "POST", body: { messages: ids, room }, query: MSG_OPTS })),
    fileToken: async (force) => (api.currentUser() ? tokens.ensure(force) : ""),
    fileUrl(m, filename, thumb) {
      const user = api.currentUser();
      if (user && !tokens.fresh()) void tokens.ensure().catch(() => {});
      const token = user ? tokens.current() : "";
      return pb.fileUrl("messages", m.id, filename, { token: token || undefined, thumb });
    },

    subscribeMessages: (room, fn) => subscribe("messages", fn, { ...MSG_OPTS, filter: pb.filter("room = {:room}", { room }) }),
    subscribeRooms: (fn) => subscribe("rooms", fn, ROOM_OPTS),
    subscribeHidden: (fn) => subscribe("hidden_rooms", fn, { fields: HIDDEN_FIELDS }),
    subscribeAllMessages: (fn) => subscribe("messages", fn, { fields: ACTIVITY_FIELDS }),
    subscribeReads: (fn) => subscribe("room_reads", fn, { fields: HIDDEN_FIELDS }),

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
