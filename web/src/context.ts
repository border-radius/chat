// What every logged-in view gets from the app shell.

import type { RoomActions } from "./actions.ts";
import type { Api } from "./api.ts";
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
  /** Unsent composer text by room id, kept while you visit other rooms (QA BUG-50). Cleared when the session ends. */
  drafts: Map<string, string>;
}
