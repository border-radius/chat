// Room list (web views/rooms.ts, §7.1, §16.5): Rooms, Direct messages, Hidden and Archived; a new room (§23.1) and a
// new conversation (user search); per-room actions on long press; unread badges (§18.4); private and Open Air marks.
// A guest gets the Open Air rooms, to read (§23.3). The header shows the server (tap to switch) and your profile.

import { Image } from "expo-image";
import { Redirect, router } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ApiError,
  errorMessage,
  LIMITS,
  otherMember,
  type Room,
  roomSections,
  roomTitle,
  textLength,
  type User,
  unreadCount,
  VISIBILITY,
  type Visibility,
  visibilityOf,
} from "../shared";
import { Avatar, Badge, Button, ErrorText, Header, Input, type MenuItem, MenuSheet, styles } from "../ui/components";
import { useAppState, useServers, useSession } from "../ui/context";
import { useTheme } from "../ui/theme";
import { UserSearch } from "../ui/UserSearch";

type Section = "rooms" | "dms" | "hidden" | "archived";

type Row =
  | { kind: "head"; key: string; section: Section; title: string }
  | { kind: "room"; key: string; room: Room; section: Section }
  | { kind: "newRoom"; key: string }
  | { kind: "newDm"; key: string }
  | { kind: "empty"; key: string; text: string }
  | { kind: "fold"; key: string; section: "hidden" | "archived"; title: string; open: boolean };

export default function Home() {
  const { session } = useServers();
  if (!session) return <Redirect href="/servers" />;
  return <Rooms />;
}

function nameError(err: unknown): string {
  if (err instanceof ApiError && err.codes.name === "validation_not_unique") return "A room with this name already exists.";
  if (err instanceof ApiError && err.fields.name) return err.fields.name;
  return errorMessage(err);
}

function Rooms() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { api, sync, unread, actions } = useSession();
  const state = useAppState((s) => s);
  const { user, site, roomsStatus } = state;
  const sections = roomSections(state);
  const [open, setOpen] = useState({ hidden: false, archived: false });
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [actionError, setActionError] = useState("");
  const [menu, setMenu] = useState<{ room: Room; section: Section } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const guest = !user;
  const title = (r: Room) => roomTitle(r, user);

  async function act(label: string, room: Room, fn: () => Promise<void>) {
    try {
      await fn();
      setActionError("");
    } catch (e) {
      setActionError(`Couldn't ${label} “${room.kind === "dm" ? title(room) : room.name}”. ${errorMessage(e)}`);
    }
  }

  async function message(u: User) {
    try {
      const room = await actions.openDm(u.id);
      setActionError("");
      setSearching(false);
      router.push(`/r/${room.id}`);
    } catch (e) {
      setActionError(`Couldn't open the conversation with “${u.name}”. ${errorMessage(e)}`);
    }
  }

  function menuItems(r: Room, section: Section): MenuItem[] {
    const mine = r.created_by === user?.id;
    const items: MenuItem[] = [];
    if (guest) return items;
    if (section === "dms") return [{ label: "Close conversation", run: () => void act("close", r, () => actions.hide(r.id)) }];
    if (section === "rooms") items.push({ label: "Hide", run: () => void act("hide", r, () => actions.hide(r.id)) });
    if (section === "hidden" || (section === "archived" && state.hidden.has(r.id)))
      items.push({ label: "Unhide", run: () => void act("unhide", r, () => actions.unhide(r.id)) });
    if (mine && section !== "archived") {
      items.push({
        label: "Archive",
        confirm: { text: `Archive “${r.name}”? It becomes read-only for everyone.`, action: "Archive room" },
        run: () => void act("archive", r, () => actions.setArchived(r.id, true)),
      });
    }
    if (mine && section === "archived")
      items.push({ label: "Unarchive", run: () => void act("unarchive", r, () => actions.setArchived(r.id, false)) });
    return items;
  }

  const rows: Row[] = [];
  const loading = roomsStatus === "idle" || roomsStatus === "loading";
  if (guest) {
    rows.push({ kind: "head", key: "h-rooms", section: "rooms", title: "Open Air rooms" });
    for (const r of sections.rooms) rows.push({ kind: "room", key: r.id, room: r, section: "rooms" });
    if (!sections.rooms.length && roomsStatus === "ready")
      rows.push({ kind: "empty", key: "e-rooms", text: "No Open Air rooms yet. Log in to see the others." });
  } else {
    rows.push({ kind: "head", key: "h-rooms", section: "rooms", title: "Rooms" });
    if (creating) rows.push({ kind: "newRoom", key: "new-room" });
    for (const r of sections.rooms) rows.push({ kind: "room", key: r.id, room: r, section: "rooms" });
    if (!sections.rooms.length && roomsStatus === "ready") {
      rows.push({
        kind: "empty",
        key: "e-rooms",
        text:
          sections.hidden.length || sections.archived.length
            ? "No other rooms. Hidden and archived ones are listed below."
            : "No rooms yet. Create the first one.",
      });
    }
    rows.push({ kind: "head", key: "h-dms", section: "dms", title: "Direct messages" });
    if (searching) rows.push({ kind: "newDm", key: "new-dm" });
    for (const r of sections.dms) rows.push({ kind: "room", key: r.id, room: r, section: "dms" });
    for (const [section, name] of [
      ["hidden", "Hidden"],
      ["archived", "Archived"],
    ] as const) {
      const list = sections[section];
      rows.push({ kind: "fold", key: `f-${section}`, section, title: `${name} (${list.length})`, open: open[section] });
      if (open[section]) for (const r of list) rows.push({ kind: "room", key: `${section}-${r.id}`, room: r, section });
    }
  }

  function renderRow(row: Row) {
    switch (row.kind) {
      case "head":
        return (
          <View style={[styles.row, { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 }]}>
            <Text
              accessibilityRole="header"
              style={{ flex: 1, color: t.muted, fontWeight: "800", fontSize: 13, textTransform: "uppercase", letterSpacing: 0.6 }}
            >
              {row.title}
            </Text>
            {guest ? null : row.section === "rooms" ? (
              <Button
                label={creating ? "Cancel" : "+ New room"}
                kind="link"
                small
                accessibilityLabel={creating ? "Cancel new room" : "New room"}
                onPress={() => setCreating(!creating)}
              />
            ) : (
              <Button
                label={searching ? "Cancel" : "+ New"}
                kind="link"
                small
                accessibilityLabel={searching ? "Cancel new message" : "New message"}
                onPress={() => setSearching(!searching)}
              />
            )}
          </View>
        );
      case "fold":
        return (
          <Pressable
            onPress={() => setOpen((o) => ({ ...o, [row.section]: !o[row.section] }))}
            accessibilityRole="button"
            accessibilityState={{ expanded: row.open }}
            style={[styles.row, { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 }]}
          >
            <Text style={{ color: t.muted, fontWeight: "800", fontSize: 13, textTransform: "uppercase", letterSpacing: 0.6 }}>
              {row.open ? "▾ " : "▸ "}
              {row.title}
            </Text>
          </Pressable>
        );
      case "empty":
        return <Text style={{ color: t.muted, paddingHorizontal: 16, paddingVertical: 8 }}>{row.text}</Text>;
      case "newRoom":
        return (
          <NewRoom
            onCreated={(room) => {
              setCreating(false);
              router.push(`/r/${room.id}`);
            }}
          />
        );
      case "newDm":
        return (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <UserSearch
              search={async (q, signal) => (await api.searchUsers(q, signal)).filter((u) => !u.no_dms && u.id !== user?.id)}
              avatarUrl={api.avatarUrl}
              onPick={(u) => void message(u)}
            />
          </View>
        );
      case "room":
        return <RoomRow room={row.room} section={row.section} onMenu={() => setMenu({ room: row.room, section: row.section })} />;
    }
  }

  const menuList = menu ? menuItems(menu.room, menu.section) : [];

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header
        title={
          <Pressable
            onPress={() => router.push("/servers")}
            accessibilityRole="button"
            accessibilityLabel={`${site.title}. Switch server`}
            style={[styles.row, { gap: 8 }]}
          >
            {site.logo ? <Image source={{ uri: site.logo }} style={{ width: 28, height: 28, borderRadius: 7 }} contentFit="cover" /> : null}
            <Text numberOfLines={1} style={{ color: t.fg, fontSize: 20, fontWeight: "800", flexShrink: 1 }}>
              {site.title}
            </Text>
            <Text style={{ color: t.muted, fontSize: 14 }}>▾</Text>
          </Pressable>
        }
        right={
          user ? (
            <Pressable
              onPress={() => router.push("/me")}
              accessibilityRole="button"
              accessibilityLabel="Your profile"
              hitSlop={8}
              style={{ padding: 4 }}
            >
              <Avatar user={user} size={34} url={api.avatarUrl} />
            </Pressable>
          ) : (
            <View style={[styles.row, { gap: 6 }]}>
              <Button label="Log in" small onPress={() => router.push("/login")} />
              <Button
                label="Sign up"
                small
                kind="primary"
                onPress={() => router.push({ pathname: "/login", params: { mode: "signup" } })}
              />
            </View>
          )
        }
      />
      {roomsStatus === "error" ? (
        <View style={[styles.row, { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: t.surface }]}>
          <Text style={{ color: t.danger, flex: 1 }}>Couldn't load rooms. Check your connection.</Text>
          <Button
            label="Retry"
            kind="link"
            small
            onPress={() => {
              void sync.reload();
              unread.refresh();
            }}
          />
        </View>
      ) : null}
      {actionError ? (
        <Pressable onPress={() => setActionError("")} style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: t.surface }}>
          <ErrorText style={{ marginTop: 0 }}>{actionError}</ErrorText>
        </Pressable>
      ) : null}
      {guest ? (
        <Text style={{ color: t.muted, paddingHorizontal: 16, paddingTop: 12 }}>
          Read any of the Open Air rooms, no account needed. Log in or sign up to join the conversation.
        </Text>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => renderRow(item)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing || (loading && !state.rooms.size)}
            colors={[t.accent]}
            tintColor={t.accent}
            onRefresh={async () => {
              setRefreshing(true);
              unread.refresh();
              await sync.reload();
              setRefreshing(false);
            }}
          />
        }
      />
      <MenuSheet
        visible={!!menu && menuList.length > 0}
        onClose={() => setMenu(null)}
        title={menu ? title(menu.room) : undefined}
        items={menuList}
      />
    </View>
  );
}

/** One room or conversation: tap to open, long press for its actions. */
function RoomRow({ room, section, onMenu }: { room: Room; section: Section; onMenu: () => void }) {
  const t = useTheme();
  const { api } = useSession();
  const n = useAppState((s) => unreadCount(s, room));
  const me = useAppState((s) => s.user);
  const dm = room.kind === "dm";
  const other = dm ? otherMember(room, me) : undefined;
  const vis = dm ? "public" : visibilityOf(room);
  const name = other ? other.name : dm ? roomTitle(room, me) : room.name;
  return (
    <Pressable
      onPress={() => router.push(`/r/${room.id}`)}
      onLongPress={me ? onMenu : undefined}
      delayLongPress={350}
      accessibilityRole="link"
      accessibilityLabel={`${dm ? name : `#${name}`}${vis !== "public" ? `, ${VISIBILITY[vis].label}` : ""}${n ? `, ${n} unread` : ""}`}
      accessibilityHint={me ? "Long press for actions" : undefined}
      style={({ pressed }) => [
        styles.row,
        { gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: pressed ? t.hover : "transparent" },
      ]}
    >
      {other ? (
        <Avatar user={other} size={36} url={api.avatarUrl} />
      ) : (
        <View style={[styles.center, { width: 36, height: 36, borderRadius: 10, backgroundColor: t.surface }]}>
          <Text style={{ color: t.accent, fontWeight: "800", fontSize: 17 }}>{vis === "public" ? "#" : VISIBILITY[vis].icon}</Text>
        </View>
      )}
      <Text
        numberOfLines={1}
        style={{ flex: 1, color: section === "archived" ? t.muted : t.fg, fontSize: 16, fontWeight: n ? "800" : "500" }}
      >
        {name}
      </Text>
      {n ? <Badge n={n} t={t} /> : null}
    </Pressable>
  );
}

/** The new-room form: a name and who can see it (§23.1). */
function NewRoom({ onCreated }: { onCreated: (room: Room) => void }) {
  const t = useTheme();
  const { actions } = useSession();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (busy) return;
    if (!name.trim()) return setError("Give the room a name.");
    if (textLength(name.trim()) > LIMITS.roomName) return setError(`Must be no more than ${LIMITS.roomName} characters.`);
    setBusy(true);
    setError("");
    try {
      onCreated(await actions.create(name, visibility));
    } catch (e) {
      setError(nameError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8 }}>
      <Input
        value={name}
        onChangeText={setName}
        placeholder="room-name"
        accessibilityLabel="Room name"
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={() => void create()}
        invalid={!!error}
      />
      <View style={[styles.row, { gap: 6, flexWrap: "wrap" }]} accessibilityRole="radiogroup" accessibilityLabel="Who can see it">
        {(["public", "private", "open"] as const).map((v) => (
          <Pressable
            key={v}
            onPress={() => setVisibility(v)}
            accessibilityRole="radio"
            accessibilityState={{ checked: visibility === v }}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: visibility === v ? t.accent : t.border,
              backgroundColor: visibility === v ? t.tint : t.raised,
            }}
          >
            <Text style={{ color: t.fg, fontWeight: visibility === v ? "700" : "500" }}>
              {VISIBILITY[v].icon} {VISIBILITY[v].label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: t.muted, fontSize: 13 }}>{VISIBILITY[visibility].hint}</Text>
      <ErrorText>{error}</ErrorText>
      <Button label="Create" kind="primary" busy={busy} onPress={() => void create()} />
    </View>
  );
}
