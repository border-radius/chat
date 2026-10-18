// What the app shares with the web client (../web/src): the API layer, the app state and the services that keep it
// live, the room controller, and the pure helpers. One source of truth for how the app talks to the server; the app
// only adds what a phone needs (sse.ts, client.ts, kv.ts) and its own screens.

export { createRoomActions, type RoomActions } from "../../web/src/actions.ts";
export {
  type Api,
  ApiError,
  createApi,
  errorMessage,
  reasonOf,
  SIGNUP_LOGIN_FAILED,
  type UnreadCounts,
} from "../../web/src/api.ts";
export type { Cache, Kept } from "../../web/src/cache.ts";
export { createDrafts, type Drafts } from "../../web/src/drafts.ts";
export { avatarColor, initials } from "../../web/src/lib/avatar.ts";
export { newer, older, PAGE_SIZE, withFiles } from "../../web/src/lib/cursor.ts";
export { CATEGORIES, EMOJI, recentEmoji, rememberEmoji } from "../../web/src/lib/emoji.ts";
export { attachmentName, checkFiles, formatBytes, isAudio, isGif, isImage, isMedia, isVideo } from "../../web/src/lib/files.ts";
export { fitWithin } from "../../web/src/lib/image.ts";
export { LIMITS, MAX_SELECTED, textLength } from "../../web/src/lib/limits.ts";
export { type Link, linkify } from "../../web/src/lib/links.ts";
export { emptyForward, lastSaved, type MessageWindow, quoteText, startsGroup } from "../../web/src/lib/messages.ts";
export { reactors } from "../../web/src/lib/reactions.ts";
export { canPost, isDm, otherMember, postingOf, roomTitle, VISIBILITY, visibilityOf } from "../../web/src/lib/rooms.ts";
export { dayLabel, formatFull, formatTime, parsePb } from "../../web/src/lib/time.ts";
export type { LocalFile, Message, Posting, Quoted, Reaction, Room, Site, User, Visibility } from "../../web/src/lib/types.ts";
export { DEFAULT_SITE } from "../../web/src/lib/types.ts";
export { type AuthStore, createAuthStore, createClient, type PbClient, PbError, type RequestOptions } from "../../web/src/pb.ts";
export { createPrefetch } from "../../web/src/prefetch.ts";
export { createScope, type Scope } from "../../web/src/scope.ts";
export { startSite } from "../../web/src/site.ts";
export {
  type AppState,
  createStore,
  initialState,
  roomSections,
  type Store,
  unreadCount,
} from "../../web/src/store.ts";
export { createSync, type Sync } from "../../web/src/sync.ts";
export { createUnread, type RoomReader, type Unread } from "../../web/src/unread.ts";
export { passwordProblem } from "../../web/src/views/profile.ts";
export { editProblem, validEdit } from "../../web/src/views/room/composer.ts";
export {
  type Change,
  createRoomController,
  type Phase,
  type RoomController,
  type RoomState,
} from "../../web/src/views/room/controller.ts";
export { createNameLookup, type NameOf } from "../../web/src/views/room/names.ts";
