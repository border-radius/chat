// Searching people by name (the web's ui/user-search.ts): results as you type, after a short pause, the older
// request cancelled by the newer one.

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { errorMessage, type User } from "../shared";
import { Avatar, Input, styles } from "./components";
import { useTheme } from "./theme";

const DEBOUNCE_MS = 250;

export function useUserSearch(search: (q: string, signal: AbortSignal) => Promise<User[]>, query: string) {
  const [state, setState] = useState<{ users: User[]; busy: boolean; error: string }>({ users: [], busy: false, error: "" });
  const latest = useRef(search);
  latest.current = search;
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setState({ users: [], busy: false, error: "" });
      return;
    }
    const ac = new AbortController();
    setState((s) => ({ ...s, busy: true, error: "" }));
    const timer = setTimeout(() => {
      latest.current(q, ac.signal).then(
        (users) => !ac.signal.aborted && setState({ users, busy: false, error: "" }),
        (e: unknown) => !ac.signal.aborted && setState({ users: [], busy: false, error: errorMessage(e) }),
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [query]);
  return state;
}

export function UserSearch({
  search,
  avatarUrl,
  onPick,
  placeholder = "Search people by name",
  exclude,
  autoFocus = true,
}: {
  search: (q: string, signal: AbortSignal) => Promise<User[]>;
  avatarUrl: (u: User, px: 48 | 96) => string;
  onPick: (u: User) => void;
  placeholder?: string;
  /** Not offered (already members). */
  exclude?: ReadonlySet<string>;
  autoFocus?: boolean;
}) {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const { users, busy, error } = useUserSearch(search, query);
  const shown = users.filter((u) => !exclude?.has(u.id));
  return (
    <View>
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
      />
      {busy ? <ActivityIndicator style={{ marginTop: 8 }} color={t.accent} /> : null}
      {error ? <Text style={{ color: t.danger, marginTop: 6 }}>{error}</Text> : null}
      {!busy && query.trim() && !error && !shown.length ? <Text style={{ color: t.muted, marginTop: 8 }}>No one found.</Text> : null}
      {shown.map((u) => (
        <Pressable
          key={u.id}
          onPress={() => onPick(u)}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.row,
            { gap: 10, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 10, backgroundColor: pressed ? t.hover : "transparent" },
          ]}
        >
          <Avatar user={u} size={32} url={avatarUrl} />
          <Text style={{ color: t.fg, fontSize: 16 }}>{u.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}
