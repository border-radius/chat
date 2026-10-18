// Room access (web views/room/access.ts, §23.2, §23.6): the creator chooses who can see the room (Private, Public or
// Open Air) and, for a private room, its members; then who can post: everyone who can see it, or only the people they
// choose. Anyone else in a private room sees who is in it (and who can post).

import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { errorMessage, LIMITS, type Posting, postingOf, type Room, type User, VISIBILITY, type Visibility, visibilityOf } from "../shared";
import { Avatar, Button, ErrorText, Sheet, styles } from "../ui/components";
import { useSession } from "../ui/context";
import { useTheme } from "../ui/theme";
import { UserSearch } from "../ui/UserSearch";

const CHOICES: readonly Visibility[] = ["private", "public", "open"];

/** Who can post (§23.6), shown like the visibilities (POSTING in web views/room/access.ts). */
const POSTING: Record<Posting, { label: string; icon: string; hint: string }> = {
  everyone: { label: "Everyone who can see it", icon: "💬", hint: "Guests of an Open Air room only read." },
  selected: { label: "Only people you choose", icon: "✋", hint: "Everyone else reads and reacts, but can't post." },
};

function warning(from: Visibility, to: Visibility): string {
  if (from === to) return "";
  if (to === "open") return "Everything ever written here, and everything to come, becomes readable by anyone on the web.";
  if (from === "private") return "Everyone with an account will be able to read the whole history.";
  if (to === "private") return "Only you and the people you add will see this room. Everyone else loses it from their list.";
  return "People without an account won't see this room any more.";
}

/** The people `ids` names, as expanded, the creator first (as the server keeps them). */
function usersOf(room: Room, ids: string[], expanded: User[] | undefined, me: User | null): User[] {
  const known = new Map([...(room.expand?.members ?? []), ...(expanded ?? [])].map((u) => [u.id, u]));
  if (me && !known.has(me.id)) known.set(me.id, me);
  const list = (ids.length ? ids : [room.created_by]).map((id) => known.get(id) ?? { id, name: "Unknown" });
  return list.sort((a, b) => Number(b.id === room.created_by) - Number(a.id === room.created_by));
}

export function AccessSheet({ room, me, onClose }: { room: Room | null; me: User | null; onClose: () => void }) {
  const t = useTheme();
  const { api, actions } = useSession();
  const editable = !!room && room.created_by === me?.id;
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [posting, setPosting] = useState<Posting>("everyone");
  const [people, setPeople] = useState<User[]>([]);
  const [writers, setWriters] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Opening: start from the room as it is (not again while it is open, which would undo your changes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when opened, or opened for another room
  useEffect(() => {
    if (!room) return;
    setVisibility(visibilityOf(room));
    setPosting(postingOf(room));
    setPeople(usersOf(room, room.members ?? [], undefined, me));
    setWriters(usersOf(room, room.writers ?? [], room.expand?.writers, me));
    setError("");
  }, [room?.id, !!room]);

  const close = () => !busy && onClose();

  async function save() {
    if (!room || busy) return;
    setBusy(true);
    setError("");
    try {
      // Made private: only members can post.
      const ids = new Set(people.map((u) => u.id));
      const posters = visibility === "private" ? writers.filter((u) => ids.has(u.id)) : writers;
      await actions.setAccess(
        room.id,
        visibility,
        people.map((u) => u.id),
        posting,
        posters.map((u) => u.id),
      );
      setBusy(false);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(`Couldn't save. ${errorMessage(e)}`);
    }
  }

  const warn = room && editable ? warning(visibilityOf(room), visibility) : "";

  function cards<T extends string>(
    label: string,
    values: readonly T[],
    info: Record<T, { label: string; icon: string; hint: string }>,
    value: T,
    set: (v: T) => void,
  ) {
    return (
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: 8 }}>
        <Text style={{ color: t.muted, fontWeight: "600" }}>{label}</Text>
        {values.map((v) => (
          <Pressable
            key={v}
            onPress={() => {
              set(v);
              setError("");
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: v === value }}
            style={[
              styles.row,
              {
                gap: 12,
                padding: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: v === value ? t.accent : t.border,
                backgroundColor: v === value ? t.tint : t.raised,
              },
            ]}
          >
            <Text style={{ fontSize: 20 }}>{info[v].icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.fg, fontWeight: "700" }}>{info[v].label}</Text>
              <Text style={{ color: t.muted, fontSize: 13 }}>{info[v].hint}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    );
  }

  return (
    <Sheet visible={!!room} onClose={close} full>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: t.fg, fontSize: 18, fontWeight: "800" }}>
          {editable ? "Room access" : `Members of #${room?.name ?? ""}`}
        </Text>
        {editable ? cards(`Who can see #${room?.name ?? ""}?`, CHOICES, VISIBILITY, visibility, setVisibility) : null}
        {visibility === "private" ? (
          <PeopleList
            label="Members"
            list={people}
            setList={(list) => {
              setPeople(list);
              // A member taken out can't post either.
              setWriters(writers.filter((w) => w.id === room?.created_by || list.some((u) => u.id === w.id)));
            }}
            room={room}
            editable={editable}
            search={api.searchUsers}
            onFull={() => setError(`A room can have up to ${LIMITS.roomMembers} members.`)}
          />
        ) : null}
        {editable ? cards("Who can post?", ["everyone", "selected"] as const, POSTING, posting, setPosting) : null}
        {posting === "selected" ? (
          <PeopleList
            label="Who can post"
            list={visibility === "private" ? writers.filter((w) => people.some((u) => u.id === w.id)) : writers}
            setList={setWriters}
            room={room}
            editable={editable}
            // In a private room, only its members.
            search={async (q, signal) => {
              const found = await api.searchUsers(q, signal);
              return visibility === "private" ? found.filter((u) => people.some((p) => p.id === u.id)) : found;
            }}
            onFull={() => setError(`A room can have up to ${LIMITS.roomMembers} people who post.`)}
          />
        ) : null}
        {warn ? <Text style={{ color: t.fg, backgroundColor: t.highlight, padding: 10, borderRadius: 10 }}>{warn}</Text> : null}
        <ErrorText>{error}</ErrorText>
        <View style={[styles.row, { gap: 8, justifyContent: "flex-end" }]}>
          <Button label={editable ? "Cancel" : "Close"} onPress={close} disabled={busy} />
          {editable ? <Button label="Save" kind="primary" busy={busy} onPress={() => void save()} /> : null}
        </View>
      </ScrollView>
    </Sheet>
  );
}

/** A list of people with Add and Remove: the members, or who can post. */
function PeopleList({
  label,
  list,
  setList,
  room,
  editable,
  search,
  onFull,
}: {
  label: string;
  list: User[];
  setList: (list: User[]) => void;
  room: Room | null;
  editable: boolean;
  search: (q: string, signal: AbortSignal) => Promise<User[]>;
  onFull: () => void;
}) {
  const t = useTheme();
  const { api } = useSession();
  const [adding, setAdding] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: closed again when the sheet opens for another room
  useEffect(() => setAdding(false), [room?.id]);

  function add(u: User) {
    if (list.some((p) => p.id === u.id)) return;
    if (list.length >= LIMITS.roomMembers) return onFull();
    setList([...list, u]);
  }

  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: t.fg, fontWeight: "800", marginTop: 4 }}>
        {label} ({list.length})
      </Text>
      {list.map((u) => {
        const owner = u.id === room?.created_by;
        return (
          <View key={u.id} style={[styles.row, { gap: 10, paddingVertical: 6 }]}>
            <Avatar user={u} size={28} url={api.avatarUrl} />
            <Text style={{ color: t.fg, flex: 1 }}>{u.name}</Text>
            {owner ? <Text style={{ color: t.muted, fontSize: 13 }}>creator</Text> : null}
            {editable && !owner ? (
              <Button
                label="Remove"
                kind="link"
                small
                accessibilityLabel={`Remove ${u.name}`}
                onPress={() => setList(list.filter((p) => p.id !== u.id))}
              />
            ) : null}
          </View>
        );
      })}
      {editable && !adding ? (
        <Button
          label="+ Add people"
          kind="link"
          small
          disabled={list.length >= LIMITS.roomMembers}
          onPress={() => setAdding(true)}
          style={{ alignSelf: "flex-start" }}
        />
      ) : null}
      {editable && adding ? (
        <UserSearch
          search={search}
          avatarUrl={api.avatarUrl}
          onPick={add}
          exclude={new Set(list.map((p) => p.id))}
          placeholder="Add people by name"
        />
      ) : null}
    </View>
  );
}
