// What the shared web modules (../web/src) expect from a browser and React Native lacks.

import { getRandomValues } from "expo-crypto";
import { Platform } from "react-native";
import { createStorage } from "./core/kv";
import { NativeEventSource } from "./core/sse";

const g = globalThis as Record<string, unknown>;

if (Platform.OS !== "web") {
  // lib/id.ts: client-generated message ids (§7.5).
  const c = (g.crypto ?? {}) as { getRandomValues?: unknown };
  if (typeof c.getRandomValues !== "function") {
    c.getRandomValues = getRandomValues;
    g.crypto = c;
  }
  // pb.ts: realtime (§7.5).
  if (typeof g.EventSource !== "function") g.EventSource = NativeEventSource;
  // lib/emoji.ts: recently used emoji. Filled in by kv.load() before the app starts.
  if (!g.localStorage) g.localStorage = createStorage("global");
}
