// The current server and its session, for every screen. Switching servers stops one session and opens the other;
// each keeps its own login (servers.ts).

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { load as loadKv } from "../core/kv";
import { currentServer, removeServer as forgetServer, listServers, type Server, setCurrentServer, upsertServer } from "../core/servers";
import { openSession, type Session } from "../core/session";
import type { AppState } from "../shared";

interface Servers {
  /** Storage and the last server are loaded. */
  ready: boolean;
  servers: Server[];
  session: Session | null;
  /** Make `url` (already probed) the current server, adding it to the list. */
  connect(url: string, site: { title: string; logo: string }): Promise<Session>;
  /** Forget a server (and its session). */
  remove(url: string): Promise<void>;
}

const Ctx = createContext<Servers | null>(null);

export function ServersProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [servers, setServers] = useState<Server[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);

  const use = useCallback((next: Session | null) => {
    if (current.current && current.current !== next) current.current.stop();
    current.current = next;
    setSession(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadKv();
      const [list, url] = await Promise.all([listServers(), currentServer()]);
      const s = url && list.some((x) => x.url === url) ? await openSession(url) : null;
      if (cancelled) return s?.stop();
      setServers(list);
      use(s);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [use]);

  // Keep the list's title and logo up to date with what the current server says (§24).
  useEffect(() => {
    if (!session) return;
    return session.store.subscribe((s, prev) => {
      if (s.site === prev.site) return;
      void upsertServer({ url: session.server, title: s.site.title, logo: s.site.logo, usedAt: Date.now() }).then(setServers);
    });
  }, [session]);

  const value = useMemo<Servers>(
    () => ({
      ready,
      servers,
      session,
      async connect(url, site) {
        if (current.current?.server === url) {
          setServers(await upsertServer({ url, ...site, usedAt: Date.now() }));
          return current.current;
        }
        const s = await openSession(url);
        await setCurrentServer(url);
        setServers(await upsertServer({ url, ...site, usedAt: Date.now() }));
        use(s);
        return s;
      },
      async remove(url) {
        if (current.current?.server === url) {
          current.current.logOut();
          use(null);
        }
        setServers(await forgetServer(url));
      },
    }),
    [ready, servers, session, use],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServers(): Servers {
  const v = useContext(Ctx);
  if (!v) throw new Error("useServers outside ServersProvider");
  return v;
}

/** The current session. Only on screens that are shown with one (the router sends you to the servers screen otherwise). */
export function useSession(): Session {
  const s = useServers().session;
  if (!s) throw new Error("No server selected");
  return s;
}

/** A slice of the session's app state, re-rendering when it changes (compared by identity). */
export function useAppState<T>(select: (s: AppState) => T): T {
  const { store } = useSession();
  const last = useRef<{ state: AppState; value: T } | null>(null);
  const get = () => {
    const state = store.get();
    if (last.current?.state !== state) {
      const value = select(state);
      last.current = { state, value: last.current && Object.is(last.current.value, value) ? last.current.value : value };
    }
    return last.current.value;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}
