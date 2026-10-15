// Room access (web views/room/access.ts, §23.2): the creator chooses who can see the room (Private, Public or Open
// Air) and, for a private room, its members. Anyone else in a private room sees who is in it.

import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { errorMessage, LIMITS, type Room, type User, VISIBILITY, type Visibility, visibilityOf } from "../shared";
import { Avatar, Button, ErrorText, Sheet, styles } from "../ui/components";
import { useSession } from "../ui/context";
import { useTheme } from "../ui/theme";
import { UserSearch } from "../ui/UserSearch";

const CHOICES: readonly Visibility[] = ["private", "public", "open"];

function warning(from: Visibility, to: Visibility): string {
  if (from === to) return "";
  if (to === "open") return "Everything ever written here, and everything to come, becomes readable by anyone on the web.";
  if (from === "private") return "Everyone with an account will be able to read the whole history.";
  if (to === "private") return "Only you and the people you add will see this room. Everyone else loses it from their list.";
  return "People without an account won't see this room any more.";
}

export function AccessSheet({ room, me, onClose }: { room: Room | null; me: User | null; onClose: () => void }) {
  const t = useTheme();
  const { api, actions } = useSession();
  const editable = !!room && room.created_by === me?.id;
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [people, setPeople] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Opening: start from the room as it is (not again while it is open, which would undo your changes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when opened, or opened for another room
  useEffect(() => {
    if (!room) return;
    setVisibility(visibilityOf(room));
    const known = new Map((room.expand?.members ?? []).map((u) => [u.id, u]));
    if (me && !known.has(me.id)) known.set(me.id, me);
    const ids = room.members?.length ? room.members : [room.created_by];
    const list = ids.map((id) => known.get(id) ?? { id, name: "Unknown" });
    list.sort((a, b) => Number(b.id === room.created_by) - Number(a.id === room.created_by));
    setPeople(list);
    setAdding(false);
    setError("");
  }, [room?.id, !!room]);

  const close = () => !busy && onClose();

  async function save() {
    if (!room || busy) return;
    setBusy(true);
    setError("");
    try {
      await actions.setAccess(
        room.id,
        visibility,
        people.map((u) => u.id),
      );
      setBusy(false);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(`Couldn't save. ${errorMessage(e)}`);
    }
  }

  function add(u: User) {
    if (people.some((p) => p.id === u.id)) return;
    if (people.length >= LIMITS.roomMembers) return setError(`A room can have up to ${LIMITS.roomMembers} members.`);
    setPeople([...people, u]);
    setError("");
  }

  const warn = room && editable ? warning(visibilityOf(room), visibility) : "";

  return (
    <Sheet visible={!!room} onClose={close} full>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: t.fg, fontSize: 18, fontWeight: "800" }}>
          {editable ? "Room access" : `Members of #${room?.name ?? ""}`}
        </Text>
        {editable ? (
          <View accessibilityRole="radiogroup" accessibilityLabel={`Who can see #${room?.name ?? ""}?`} style={{ gap: 8 }}>
            <Text style={{ color: t.muted, fontWeight: "600" }}>Who can see #{room?.name}?</Text>
            {CHOICES.map((v) => (
              <Pressable
                key={v}
                onPress={() => {
                  setVisibility(v);
                  setError("");
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: v === visibility }}
                style={[
                  styles.row,
                  {
                    gap: 12,
                    padding: 12,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: v === visibility ? t.accent : t.border,
                    backgroundColor: v === visibility ? t.tint : t.raised,
                  },
                ]}
              >
                <Text style={{ fontSize: 20 }}>{VISIBILITY[v].icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.fg, fontWeight: "700" }}>{VISIBILITY[v].label}</Text>
                  <Text style={{ color: t.muted, fontSize: 13 }}>{VISIBILITY[v].hint}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}
        {visibility === "private" ? (
          <View style={{ gap: 4 }}>
            <Text style={{ color: t.fg, fontWeight: "800", marginTop: 4 }}>Members ({people.length})</Text>
            {people.map((u) => {
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
                      onPress={() => setPeople(people.filter((p) => p.id !== u.id))}
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
                disabled={people.length >= LIMITS.roomMembers}
                onPress={() => setAdding(true)}
                style={{ alignSelf: "flex-start" }}
              />
            ) : null}
            {editable && adding ? (
              <UserSearch
                search={api.searchUsers}
                avatarUrl={api.avatarUrl}
                onPick={add}
                exclude={new Set(people.map((p) => p.id))}
                placeholder="Add people by name"
              />
            ) : null}
          </View>
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
