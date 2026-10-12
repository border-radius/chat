// What every logged-in view gets from the app shell.

import type { RoomActions } from "./actions.ts";
import type { Api } from "./api.ts";
import type { Drafts } from "./drafts.ts";
import type { AppState, Store } from "./store.ts";
import type { Sync } from "./sync.ts";
import type { Unread } from "./unread.ts";

export interface Ctx {
  api: Api;
  store: Store<AppState>;
  sync: Sync;
  unread: Unread;
  actions: RoomActions;
  navigate: (hash: string) => void;
  /** Start the current page over, with the same route (a room you can see again, §23.4). */
  reopen: () => void;
  /** Unsent composer text by room id, kept across rooms (QA BUG-50) and reloads (§22.3). Cleared when the session ends. */
  drafts: Drafts;
  /** End the session and go to the login screen (the profile page's Log out, §22.2). */
  logOut: () => void;
}
