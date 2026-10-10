// Hash router (§7.1, §7.2). Idempotent: re-resolving to the mounted route does nothing.

export interface View {
  mount(root: HTMLElement, params: Record<string, string>): void;
  unmount(): void;
}

export interface Route {
  pattern: string;
  view: () => View;
  /** Reachable without auth (only the login screen). */
  public?: boolean;
}

export interface Router {
  start(): void;
  stop(): void;
  navigate(hash: string): void;
  /** Re-check the current route, e.g. after auth changes. */
  refresh(): void;
}

const HOME = "#/";
const LOGIN = "#/login";

export function matchRoute(patterns: readonly string[], hash: string): { pattern: string; params: Record<string, string> } | null {
  const path = hash === "" || hash === "#" ? HOME : hash;
  const parts = path.split("/");
  for (const pattern of patterns) {
    const pp = pattern.split("/");
    if (pp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pp.every((seg, i) => {
      const part = parts[i]!;
      if (!seg.startsWith(":")) return seg === part;
      if (!part) return false;
      params[seg.slice(1)] = decodeURIComponent(part);
      return true;
    });
    if (ok) return { pattern, params };
  }
  return null;
}

export function createRouter(opts: { root: HTMLElement; routes: Route[]; isAuthed: () => boolean }): Router {
  const { root, routes, isAuthed } = opts;
  const patterns = routes.map((r) => r.pattern);
  let current: { key: string; view: View } | null = null;
  let running = false;

  function unmountCurrent() {
    current?.view.unmount();
    current = null;
  }

  function resolve() {
    if (!running) return;
    const hash = location.hash;
    const m = matchRoute(patterns, hash);
    const route = m && routes.find((r) => r.pattern === m.pattern)!;
    let target: string | null = null;
    if (!route) target = HOME;
    else if (!route.public && !isAuthed()) target = LOGIN;
    else if (route.pattern === LOGIN && isAuthed()) target = HOME;
    if (target !== null && target !== hash) {
      history.replaceState(null, "", target);
      return resolve();
    }

    const key = hash || HOME;
    if (current?.key === key) return;
    unmountCurrent();
    const view = route!.view();
    current = { key, view };
    view.mount(root, m!.params);
  }

  const onHashChange = () => resolve();

  return {
    start() {
      running = true;
      window.addEventListener("hashchange", onHashChange);
      resolve();
    },
    stop() {
      running = false;
      window.removeEventListener("hashchange", onHashChange);
      unmountCurrent();
    },
    navigate(hash) {
      if (location.hash === hash) resolve();
      else location.hash = hash;
    },
    refresh() {
      resolve();
    },
  };
}
