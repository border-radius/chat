// Forward messages (web views/room/forward.ts, §21.3): to any of your rooms or conversations, or to someone you have
// no conversation with yet (found by name).

import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { canPost, otherMember, type Room, roomSections, roomTitle, type User } from "../shared";
import { Avatar, Button, Input, Sheet, styles } from "../ui/components";
import { useAppState, useSession } from "../ui/context";
import { useTheme } from "../ui/theme";
import { useUserSearch } from "../ui/UserSearch";

export type ForwardTo = { room: Room } | { user: User };

export function ForwardSheet({
  count,
  onPick,
  onClose,
}: {
  /** How many messages: 0 = closed. */
  count: number;
  /** Resolves to what went wrong, or null once forwarded (the sheet then closes). */
  onPick: (to: ForwardTo) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useTheme();
  const { api } = useSession();
  const state = useAppState((s) => s);
  const me = state.user;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const people = useUserSearch(api.searchUsers, query);

  const s = roomSections(state);
  // Only where you may post (§23.6).
  const all = [...s.dms, ...s.rooms, ...s.hidden].filter((r) => canPost(r, me));
  const q = query.trim().toLowerCase();
  const rooms = all.filter((r) => roomTitle(r, me).toLowerCase().includes(q));
  const inDms = new Set(all.map((r) => otherMember(r, me)?.id));
  const found = q ? people.users.filter((u) => !u.no_dms && u.id !== me?.id && !inDms.has(u.id)) : [];
  const items: { key: string; label: string; user?: User; to: ForwardTo }[] = [
    ...rooms.map((r) => {
      const other = otherMember(r, me);
      return { key: r.id, label: other ? roomTitle(r, me) : r.name, ...(other ? { user: other } : {}), to: { room: r } };
    }),
    ...found.map((u) => ({ key: `u-${u.id}`, label: u.name, user: u, to: { user: u } })),
  ];

  const close = () => {
    if (busy) return; // what happens to the forward must be seen
    setQuery("");
    setProblem("");
    onClose();
  };

  async function pick(to: ForwardTo) {
    if (busy) return;
    setBusy(true);
    setProblem("");
    const p = await onPick(to);
    setBusy(false);
    if (p === null) {
      setQuery("");
      onClose();
    } else setProblem(p);
  }

  return (
    <Sheet visible={count > 0} onClose={close} full>
      <View style={{ paddingHorizontal: 16, gap: 10, flex: 1 }}>
        <Text accessibilityRole="header" style={{ color: t.fg, fontSize: 18, fontWeight: "800" }}>
          {count === 1 ? "Forward message" : `Forward ${count} messages`}
        </Text>
        <Input value={query} onChangeText={setQuery} placeholder="Search rooms and people" accessibilityLabel="Search rooms and people" />
        {busy ? (
          <View style={[styles.row, { gap: 8 }]}>
            <ActivityIndicator color={t.accent} />
            <Text style={{ color: t.muted }}>Forwarding…</Text>
          </View>
        ) : problem ? (
          <Text style={{ color: t.danger }}>{problem}</Text>
        ) : !items.length ? (
          <Text style={{ color: t.muted }}>{people.busy ? "Searching…" : "Nothing found."}</Text>
        ) : null}
        <FlatList
          style={{ flex: 1 }}
          data={items}
          keyExtractor={(i) => i.key}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              onPress={() => void pick(item.to)}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.row,
                { gap: 12, paddingVertical: 10, borderRadius: 10, backgroundColor: pressed ? t.hover : "transparent" },
              ]}
            >
              {item.user ? (
                <Avatar user={item.user} size={32} url={api.avatarUrl} />
              ) : (
                <View style={[styles.center, { width: 32, height: 32, borderRadius: 8, backgroundColor: t.surface }]}>
                  <Text style={{ color: t.accent, fontWeight: "800" }}>#</Text>
                </View>
              )}
              <Text style={{ color: t.fg, fontSize: 16 }} numberOfLines={1}>
                {item.label}
              </Text>
            </Pressable>
          )}
        />
        <Button label="Cancel" onPress={close} disabled={busy} />
      </View>
    </Sheet>
  );
}
