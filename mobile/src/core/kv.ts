// A synchronous Storage (what web/src's drafts, site cache and recent emoji use) over AsyncStorage: everything is read
// into memory once at startup (load()), reads come from memory, writes go to both. Small values only: the room cache
// (cache.ts) goes to AsyncStorage directly.

import AsyncStorage from "@react-native-async-storage/async-storage";

const PREFIX = "kv:";

const memory = new Map<string, string>();
let loaded: Promise<void> | null = null;

/** Read every kv value into memory. Call (and await) once before anything uses a Storage from here. */
export function load(): Promise<void> {
  loaded ??= (async () => {
    try {
      const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
      for (const [k, v] of await AsyncStorage.multiGet(keys)) if (v !== null) memory.set(k.slice(PREFIX.length), v);
    } catch {
      // storage unavailable: start empty, like a private window would
    }
  })();
  return loaded;
}

const persist = (key: string, value: string | null) =>
  void (value === null ? AsyncStorage.removeItem(PREFIX + key) : AsyncStorage.setItem(PREFIX + key, value)).catch(() => {});

/** A Storage whose keys live under `namespace` (e.g. one server's), apart from every other one's. */
export function createStorage(namespace: string): Storage {
  const ns = `${namespace}|`;
  const own = () => [...memory.keys()].filter((k) => k.startsWith(ns));
  const storage: Storage = {
    get length() {
      return own().length;
    },
    key: (i) => own()[i]?.slice(ns.length) ?? null,
    getItem: (key) => memory.get(ns + key) ?? null,
    setItem(key, value) {
      const v = String(value);
      memory.set(ns + key, v);
      persist(ns + key, v);
    },
    removeItem(key) {
      if (!memory.delete(ns + key)) return;
      persist(ns + key, null);
    },
    clear() {
      for (const k of own()) {
        memory.delete(k);
        persist(k, null);
      }
    },
  };
  return storage;
}

/** Remove every key of `namespace` (a server that was removed). */
export function clearNamespace(namespace: string): void {
  createStorage(namespace).clear();
}
