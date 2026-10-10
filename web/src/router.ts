// Hash router (§7.1, §7.2). Idempotent: re-resolving to the mounted route does nothing.

export interface View {
  mount(root: HTMLElement, params: Record<string, string>): void;
  unmount(): void;
  /**
   * Optional: take new params in place. Used instead of a remount when the next route has the same view
   * factory, e.g. switching rooms keeps the sidebar mounted.
   */
  update?(params: Record<string, string>): void;
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

export function matchRoute<R extends { pattern: string }>(
  routes: readonly R[],
  hash: string,
): { route: R; params: Record<string, string> } | null {
  const path = hash === "" || hash === "#" ? HOME : hash;
  const parts = path.split("/");
  for (const route of routes) {
    const pp = route.pattern.split("/");
    if (pp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pp.every((seg, i) => {
      const part = parts[i]!;
      if (!seg.startsWith(":")) return seg === part;
      if (!part) return false;
      params[seg.slice(1)] = decodeURIComponent(part);
      return true;
    });
    if (ok) return { route, params };
  }
  return null;
}

export function createRouter(opts: { root: HTMLElement; routes: Route[]; isAuthed: () => boolean }): Router {
  const { root, routes, isAuthed } = opts;
  let current: { key: string; factory: () => View; view: View } | null = null;
  let running = false;

  function unmountCurrent() {
    current?.view.unmount();
    current = null;
  }

  /** Where `hash` must go instead, or null if it may be shown. */
  function redirect(route: Route | undefined): string | null {
    if (!route) return HOME;
    if (!route.public && !isAuthed()) return LOGIN;
    if (route.pattern === LOGIN && isAuthed()) return HOME;
    return null;
  }

  function resolve() {
    if (!running) return;
    const hash = location.hash;
    const m = matchRoute(routes, hash);
    const target = redirect(m?.route);
    if (target !== null && target !== hash) {
      history.replaceState(null, "", target);
      return resolve();
    }
    if (!m) return; // unreachable: no match always redirects to HOME, which matches

    const key = hash || HOME;
    if (current?.key === key) return;
    if (current?.factory === m.route.view && current.view.update) {
      current.key = key;
      current.view.update(m.params);
      return;
    }
    unmountCurrent();
    const view = m.route.view();
    current = { key, factory: m.route.view, view };
    view.mount(root, m.params);
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
