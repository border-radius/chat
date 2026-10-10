// Lifetime of a mounted view or a running service: one place to collect everything to undo on dispose.
//
//   const scope = createScope();
//   h("button", { on: { click }, signal: scope.signal });  // listeners go away with the scope
//   scope.defer(store.subscribe(render));                 // any cleanup function
//   scope.sub(api.subscribeMessages(room, onMessage));    // realtime: unsubscribed once it resolves
//   if (!scope.active) return;                            // after an await: was it disposed meanwhile?

import type { Unsubscribe } from "./api.ts";

export interface Scope {
  /** Aborted on dispose: pass to addEventListener / h() / fetches. */
  readonly signal: AbortSignal;
  /** False once disposed. Async work checks it after every await. */
  readonly active: boolean;
  /** Run `fn` on dispose (in reverse order of registration). */
  defer(fn: () => unknown): void;
  /** Unsubscribe a realtime subscription on dispose, even if it is still being set up. */
  sub(subscription: Promise<Unsubscribe>): void;
  dispose(): void;
}

export function createScope(): Scope {
  const ac = new AbortController();
  const cleanups: (() => unknown)[] = [];
  return {
    signal: ac.signal,
    get active() {
      return !ac.signal.aborted;
    },
    defer(fn) {
      if (ac.signal.aborted) void fn();
      else cleanups.push(fn);
    },
    sub(subscription) {
      this.defer(() => subscription.then((off) => off()).catch(() => {}));
    },
    dispose() {
      if (ac.signal.aborted) return;
      ac.abort();
      for (const fn of cleanups.reverse()) {
        try {
          void fn();
        } catch {
          // one failing cleanup must not keep the others from running
        }
      }
      cleanups.length = 0;
    },
  };
}
