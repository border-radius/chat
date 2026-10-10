// File token cache (§17.3): protected attachments need a short-lived token in their URL. Keeps one fresh,
// sharing a single request between callers.

/** Refresh tokens older than this (PocketBase's default lifetime is 3 minutes). */
export const TOKEN_MAX_AGE_MS = 120_000;

export interface TokenCache {
  /** The cached token, fresh or not ("" before the first one). */
  current(): string;
  fresh(): boolean;
  /** A fresh token: the cached one, the one being fetched, or a new one (`force`: always a new one). */
  ensure(force?: boolean): Promise<string>;
  /** Forget the token (the user changed). */
  reset(): void;
}

export function createTokenCache(fetchToken: () => Promise<string>, now: () => number = Date.now): TokenCache {
  let token = "";
  let at = 0;
  let inflight: Promise<string> | null = null;
  let generation = 0;
  const fresh = () => token !== "" && now() - at < TOKEN_MAX_AGE_MS;

  return {
    current: () => token,
    fresh,
    ensure(force = false) {
      if (!force && fresh()) return Promise.resolve(token);
      if (inflight) return inflight;
      const gen = generation;
      const started = now();
      const p = fetchToken().then((t) => {
        if (gen === generation) {
          token = t;
          at = started;
        }
        return t;
      });
      inflight = p;
      const clear = () => {
        if (inflight === p) inflight = null;
      };
      p.then(clear, clear);
      return p;
    },
    reset() {
      generation++;
      token = "";
      at = 0;
      inflight = null;
    },
  };
}
