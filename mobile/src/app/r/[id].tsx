// A room (web views/room.ts, §7.5, §7.6): the shared room controller (web/src/views/room/controller.ts: windowed
// history, realtime, reconnects, optimistic sending, edits, deletes, reactions, deleting several) on an inverted list.
// Replies (§19), reactions and the emoji picker (§20), selecting to forward or delete (§21), room access (§23.2), the
// viewer (§17.7), read state (§18.3), drafts (§22.3), archived and guest modes (§23.3).

import * as Clipboard from "expo-clipboard";
import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { nativeOf } from "../../core/files";
import { AccessSheet } from "../../room/AccessSheet";
import { Composer, type ComposerHandle } from "../../room/Composer";
import { EmojiPicker } from "../../room/EmojiPicker";
import { ForwardSheet, type ForwardTo } from "../../room/ForwardSheet";
import { MessageItem, type MessageUi, type MsgError, ServiceLine, type ShownReaction } from "../../room/MessageItem";
import { openFile, openLink } from "../../room/open";
import { type Media, Viewer, type ViewerProps } from "../../room/Viewer";
import {
  attachmentName,
  type Change,
  createNameLookup,
  createRoomController,
  createScope,
  dayLabel,
  emptyForward,
  errorMessage,
  formatFull,
  formatTime,
  isAudio,
  isDm,
  isMedia,
  lastSaved,
  MAX_SELECTED,
  type Message,
  newer,
  older,
  otherMember,
  PAGE_SIZE,
  parsePb,
  type Quoted,
  quoteText,
  type RoomReader,
  reactors,
  reasonOf,
  recentEmoji,
  roomTitle,
  startsGroup,
  type User,
  VISIBILITY,
  validEdit,
  visibilityOf,
  withFiles,
} from "../../shared";
import { Avatar, Button, Header, IconButton, type MenuItem, MenuSheet, styles } from "../../ui/components";
import { useAppState, useServers, useSession } from "../../ui/context";
import { useTheme } from "../../ui/theme";

/** How long a confirmation ("Message forwarded.") stays (§22.6). */
const NOTICE_MS = 4000;
/** Within this many px of the newest message: following new ones, and they count as read. */
const NEAR_PX = 80;
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const LIMIT_NOTICE = `You can select up to ${MAX_SELECTED} messages at a time.`;

type Row =
  | { kind: "msg"; key: string; m: Message; groupStart: boolean; quoted: Quoted | null }
  | { kind: "service"; key: string; m: Message }
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: string }
  | { kind: "begin"; key: string; text: string };

export default function RoomScreen() {
  const { session } = useServers();
  if (!session) return <Redirect href="/servers" />;
  return <RoomGate />;
}

/** A fresh room view for every room, message link, user (logging in or out), and when the room comes back (§23.4). */
function RoomGate() {
  const { id, msg } = useLocalSearchParams<{ id: string; msg?: string }>();
  const user = useAppState((s) => s.user?.id ?? "");
  const [round, setRound] = useState(0);
  return <Room key={`${id}|${msg ?? ""}|${user}|${round}`} roomId={id} msgId={msg} reopen={() => setRound((n) => n + 1)} />;
}

function Room({ roomId, msgId, reopen }: { roomId: string; msgId: string | undefined; reopen: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // With the keyboard up, the composer sits right on it: no room left for the navigation bar.
  const keyboardOpen = useKeyboardState((k) => k.isVisible);
  const bottomInset = keyboardOpen ? 0 : insets.bottom;
  const session = useSession();
  const { api, store, unread, actions, drafts, cache } = session;
  const room = useAppState((s) => s.rooms.get(roomId));
  const hidden = useAppState((s) => s.hidden.has(roomId));
  const me = useAppState((s) => s.user);
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  const list = useRef<FlatList<Row>>(null);
  const near = useRef(true);
  const [nearState, setNearState] = useState(true);
  const pendingScroll = useRef<Change["scroll"] | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const [notice, setNoticeState] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const errors = useRef(new Map<string, MsgError>());
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [sheet, setSheet] = useState<Message | null>(null);
  const [authorSheet, setAuthorSheet] = useState<User | null>(null);
  const [reactFor, setReactFor] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<string[]>([]);
  const [accessOpen, setAccessOpen] = useState(false);
  const [roomMenu, setRoomMenu] = useState(false);
  const [viewer, setViewer] = useState<ViewerProps | null>(null);
  const [gone, setGone] = useState(false);
  const focused = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again each time the sheet opens (recent emoji change)
  const quick = useMemo(() => [...new Set([...recentEmoji(), ...QUICK_REACTIONS])].slice(0, 6), [sheet]);

  const say = useCallback((text: string) => {
    clearTimeout(noticeTimer.current);
    setNoticeState(text);
  }, []);
  const flash = useCallback((text: string) => {
    clearTimeout(noticeTimer.current);
    setNoticeState(text);
    noticeTimer.current = setTimeout(() => setNoticeState((n) => (n === text ? "" : n)), NOTICE_MS);
  }, []);

  // ---------------------------------------------------------------- the controller

  const [{ scope, ctl, nameOf }] = useState(() => {
    const scope = createScope();
    const ctl = createRoomController({
      api,
      store,
      roomId,
      msgId,
      scope,
      nearBottom: () => near.current,
      onChange: (c) => {
        if (c.notice !== undefined) say(c.notice);
        if (c.scroll) pendingScroll.current = c.scroll;
        redraw();
      },
      onUpload: (id, fraction) => setUploads((u) => ({ ...u, [id]: fraction })),
      cache,
    });
    const nameOf = createNameLookup({
      usersById: (ids, signal) => api.usersById(ids, signal),
      signedIn: () => !!store.get().user,
      onFound: () => redraw(),
      signal: scope.signal,
    });
    return { scope, ctl, nameOf };
  });
  const s = ctl.state();

  const reader = useRef<RoomReader | null>(null);
  const atLiveEdge = () => {
    const st = ctl.state();
    return focused.current && st.phase === "ready" && !st.win.hasNewer && near.current && !store.get().away;
  };
  const markRead = () => {
    if (!reader.current || !atLiveEdge()) return;
    const last = lastSaved(ctl.state().win);
    if (last) reader.current.seen(last.created);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount (the screen is keyed by room and user)
  useEffect(() => {
    reader.current = unread.open(roomId);
    const r = reader.current;
    ctl.start();
    // The room went from your list while open (§23.4): what was on screen goes too.
    const off = store.subscribe((st, prev) => {
      if (prev.rooms.has(roomId) && !st.rooms.has(roomId) && st.user === prev.user && ctl.state().phase !== "not-found") {
        setGone(true);
        scope.dispose();
      }
      if (st.away !== prev.away && !st.away) markRead();
    });
    return () => {
      off();
      r.close(atLiveEdge() && !ctl.state().stale);
      scope.dispose();
      clearTimeout(noticeTimer.current);
    };
  }, []);

  // Shown "not found" or "gone": once the room is yours to see again, start over.
  const lost = gone || s.phase === "not-found";
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount (the screen is keyed by room and user)
  useEffect(() => {
    if (!lost) return;
    return store.subscribe((st, prev) => {
      if (st.rooms.has(roomId) && !prev.rooms.has(roomId) && st.user === prev.user) reopen();
    });
  }, [lost]);

  // The room you are in (§18.3): its new messages aren't counted while you read it. Another room opened on top of
  // this one (a link, a DM) is the one you are in until you come back.
  useFocusEffect(
    // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount (the screen is keyed by room and user)
    useCallback(() => {
      focused.current = true;
      store.set({ activeRoomId: roomId });
      markRead();
      return () => {
        focused.current = false;
        if (store.get().activeRoomId === roomId) store.set({ activeRoomId: null });
      };
    }, []),
  );

  // ---------------------------------------------------------------- after each render

  // Selected messages that left the window or can't be selected any more drop out (§21.1).
  const stillSelected = selected && new Set([...selected].filter((id) => ctl.find(id) && ctl.selectable(ctl.find(id)!)));
  if (selected && stillSelected && stillSelected.size !== selected.size)
    queueMicrotask(() => setSelected(stillSelected.size ? stillSelected : null));
  // The reply follows its message; deleted (or the room archived), there's nothing left to reply to.
  const replyNow = replyTo ? (ctl.find(replyTo.id) ?? replyTo) : null;
  if (replyTo && replyNow && !ctl.repliable(replyNow)) queueMicrotask(() => setReplyTo(null));
  // An edit only stays open while its message can still be edited.
  const editMsg = editing ? ctl.find(editing) : undefined;
  if (editing && (!editMsg || !ctl.editable(editMsg))) queueMicrotask(() => setEditing(null));

  // ---------------------------------------------------------------- rows

  const rows = useRows(s, beginningLabel());

  useLayoutEffect(() => {
    const scroll = pendingScroll.current;
    pendingScroll.current = null;
    if (scroll === "bottom") list.current?.scrollToOffset({ offset: 0, animated: false });
    else if (scroll === "top") list.current?.scrollToEnd({ animated: false });
    else if (scroll === "target") {
      const st = ctl.state();
      const key = st.targetId ?? (st.unreadId ? "new-line" : null);
      const index = key ? rows.findIndex((r) => r.key === key) : -1;
      if (index >= 0) list.current?.scrollToIndex({ index, viewPosition: st.targetId ? 0.5 : 0.8, animated: false });
    }
    markRead();
  });

  function beginningLabel() {
    if (!room) return "Beginning of the room";
    return isDm(room) ? `Beginning of your conversation with ${otherMember(room, me)?.name ?? "Unknown"}` : `Beginning of #${room.name}`;
  }

  // ---------------------------------------------------------------- actions

  function toggleSelect(id: string) {
    const m = ctl.find(id);
    if (!m || !ctl.selectable(m)) return;
    setSheet(null);
    setSelected((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(id)) next.delete(id);
      else if (next.size >= MAX_SELECTED) {
        say(LIMIT_NOTICE);
        return cur;
      } else next.add(id);
      if (!next.size) return null;
      return next;
    });
  }

  function endSelect() {
    setSelected(null);
    setNoticeState((n) => (n === LIMIT_NOTICE ? "" : n));
  }

  // Android's back button stops selecting first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only whether selecting matters
  useEffect(() => {
    if (!selected) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      endSelect();
      return true;
    });
    return () => sub.remove();
  }, [!!selected]);

  async function saveEdit(id: string, raw: string) {
    const m = ctl.find(id);
    const text = m ? validEdit(raw, !!m.files?.length) : null;
    if (text === null) return;
    setEditing(null);
    errors.current.delete(id);
    const saving = ctl.edit(id, text);
    if ((await saving) !== false || !scope.active) return;
    errors.current.set(id, { text: "Couldn't save your edit.", retry: () => void saveEdit(id, text) });
    redraw();
  }

  async function doDelete(id: string) {
    errors.current.delete(id);
    if ((await ctl.remove(id)) !== false || !scope.active) return;
    errors.current.set(id, { text: "Couldn't delete this message.", retry: () => void doDelete(id) });
    redraw();
  }

  async function react(id: string, emoji: string, on: boolean) {
    errors.current.delete(id);
    const saving = ctl.react(id, emoji, on);
    if (!saving) return redraw();
    if ((await saving) || !scope.active) return;
    errors.current.set(id, {
      text: on ? `Couldn't add your ${emoji} reaction.` : `Couldn't remove your ${emoji} reaction.`,
      retry: () => void react(id, emoji, on),
    });
    redraw();
  }

  async function deleteSelected(ids: string[]) {
    endSelect();
    const failed = await ctl.removeMany(ids);
    if (failed && scope.active) say(`Couldn't delete those messages. ${reasonOf(failed)}`);
  }

  async function messageUser(userId: string) {
    try {
      const dm = await actions.openDm(userId);
      if (scope.active) router.push(`/r/${dm.id}`);
    } catch (e) {
      if (scope.active) say(`Couldn't open that conversation. ${errorMessage(e)}`);
    }
  }

  async function forwardTo(to: ForwardTo): Promise<string | null> {
    const ids = forwarding.filter((id) => {
      const m = ctl.find(id);
      return !m || !(m.deleted || emptyForward(m));
    });
    if (!ids.length) return "Couldn't forward. A message was deleted.";
    try {
      const target = "room" in to ? to.room : await actions.openDm(to.user.id);
      const n = (await api.forward(ids, target.id)).length;
      if (!scope.active) return null;
      endSelect();
      if (target.id !== roomId) router.push(`/r/${target.id}`);
      else flash(n === 1 ? "Message forwarded." : `${n} messages forwarded.`);
      return null;
    } catch (e) {
      return `Couldn't forward. ${reasonOf(e)}`;
    }
  }

  function openMedia(m: Message, file: string) {
    if (isAudio(file)) {
      setViewer(viewerProps([{ message: m, file }], 0, [false, false]));
      return;
    }
    const media = (x: Message): Media[] => (x.files ?? []).filter(isMedia).map((f) => ({ message: x, file: f }));
    const { win } = ctl.state();
    const items = win.items.flatMap((x) => (x.deleted || x.localFiles?.length ? [] : media(x)));
    const start = Math.max(
      0,
      items.findIndex((i) => i.message.id === m.id && i.file === file),
    );
    setViewer(
      viewerProps(items, start, [win.hasOlder, win.hasNewer], async (back, edge) => {
        const page = await api.page(withFiles(back ? older(roomId, edge) : newer(roomId, edge)), scope.signal);
        const ordered = back ? page.reverse() : page;
        return { media: ordered.flatMap((x) => (x.deleted ? [] : media(x))), done: page.length < PAGE_SIZE };
      }),
    );
  }

  function viewerProps(items: Media[], start: number, more: [boolean, boolean], page?: ViewerProps["page"]): ViewerProps {
    return {
      items,
      start,
      more,
      page: page ?? (async () => ({ media: [], done: true })),
      fileUrl: api.fileUrl,
      refreshFileToken: () => api.fileToken(true),
      onClose: () => setViewer(null),
    };
  }

  // The same object for every message, so a message redraws only when what it shows changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one object per theme: what it calls reads the latest state through refs and the controller
  const ui = useMemo<MessageUi>(
    () => ({
      t,
      me: () => store.get().user,
      avatarUrl: api.avatarUrl,
      fileUrl: api.fileUrl,
      refreshFileToken: () => api.fileToken(true),
      onPress: (m) => sel.current && toggleSelect(m.id),
      onLongPress: (m) => (sel.current ? toggleSelect(m.id) : m.author ? setSheet(m) : undefined),
      onOpenQuote: (id) => void ctl.goTo(id),
      onReact: (id, emoji, on) => void react(id, emoji, on),
      onReactionInfo: (r) => flash(`${r.emoji} ${r.who}`),
      onPickReaction: (id) => setReactFor(id),
      onRetrySend: (id) => void ctl.retrySend(id),
      onDiscard: (id) => ctl.discard(id),
      onOpenMedia: (m, file) => openMedia(m, file),
      onOpenFile: (m, file) =>
        void openFile(api.fileUrl(m, file), attachmentName(m, file)).catch((e: unknown) =>
          say(`Couldn't open that file. ${errorMessage(e)}`),
        ),
      onAuthor: (u) => {
        const user = store.get().user;
        if (user && u.id !== user.id && u.name !== "Unknown" && !u.no_dms) setAuthorSheet(u);
      },
      onLink: (href) => openLink(href, session.server),
    }),
    [t],
  );
  // Read by the stable `ui` callbacks: whether selecting now.
  const sel = useRef(selected);
  sel.current = selected;

  // ---------------------------------------------------------------- rendering a row

  const myId = me?.id ?? "";
  const names = new Map<string, string>();
  if (me) names.set(me.id, me.name);
  for (const m of s.win.items) if (m.expand?.author) names.set(m.expand.author.id, m.expand.author.name);

  function renderRow({ item }: { item: Row }) {
    switch (item.kind) {
      case "day":
        return (
          <View style={{ alignItems: "center", paddingVertical: 10 }}>
            <Text
              style={{
                color: t.muted,
                fontWeight: "700",
                fontSize: 12,
                backgroundColor: t.surface,
                paddingHorizontal: 10,
                paddingVertical: 3,
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              {item.label}
            </Text>
          </View>
        );
      case "new":
        return (
          <View style={[styles.row, { paddingHorizontal: 12, paddingVertical: 4, gap: 8 }]}>
            <View style={{ flex: 1, height: 1, backgroundColor: t.accent2 }} />
            <Text style={{ color: t.accent2, fontWeight: "800", fontSize: 12 }}>New</Text>
          </View>
        );
      case "begin":
        return <Text style={{ color: t.muted, textAlign: "center", paddingVertical: 16, fontWeight: "600" }}>{item.text}</Text>;
      case "service":
        return <ServiceLine t={t} text={item.m.text} time={formatTime(parsePb(item.m.created))} />;
      case "msg": {
        const m = item.m;
        const picked = selected && ctl.selectable(m) ? selected.has(m.id) : null;
        const reactable = ctl.reactable(m);
        const reactions: ShownReaction[] = m.deleted
          ? []
          : ctl.reactions(m).map((r) => ({ ...r, who: reactors(r.users, myId, (id) => names.get(id) ?? nameOf(id)) }));
        const ms = parsePb(m.created);
        const time = formatTime(ms);
        const err = errors.current.get(m.id);
        const sig = JSON.stringify([
          m.text,
          m.deleted,
          m.edited_at,
          m.status ?? "",
          m.created,
          time,
          item.groupStart,
          reactable,
          !!selected,
          picked,
          m.forwarded_from ? (m.expand?.forwarded_from?.name ?? "") : "",
          reactions.map((r) => [r.emoji, r.users.length, r.users.includes(myId), r.who]),
          item.quoted ? [item.quoted.expand?.author?.name ?? "", quoteText(item.quoted)] : null,
          err?.text ?? "",
          s.targetId === m.id,
          m.expand?.author?.name ?? "",
          m.expand?.author?.avatar ?? "",
          (m.files ?? []).join("/"),
          (m.localFiles ?? []).map((f) => nativeOf(f).uri).join("/"),
          editing === m.id,
        ]);
        return (
          <MessageItem
            m={m}
            sig={sig}
            groupStart={item.groupStart}
            quoted={item.quoted}
            target={s.targetId === m.id || editing === m.id}
            picked={picked}
            selecting={!!selected}
            reactions={reactions}
            reactable={reactable}
            time={time}
            fullTime={formatFull(ms)}
            edited={m.edited_at ? formatFull(parsePb(m.edited_at)) : ""}
            error={err}
            upload={uploads[m.id] ?? 0}
            ui={ui}
          />
        );
      }
    }
  }

  // ---------------------------------------------------------------- scrolling

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const y = e.nativeEvent.contentOffset.y;
    const isNear = y <= NEAR_PX;
    near.current = isNear;
    if (isNear !== nearState) setNearState(isNear);
    if (isNear) {
      ctl.dismissPill();
      markRead();
    }
    if (y < 600 && ctl.state().win.hasNewer) void ctl.loadEdge("bottom");
  }

  const pillShown = s.pill !== null || (s.phase === "ready" && (s.win.hasNewer || !nearState));
  const pillText = s.pill === "history" ? "New messages · Jump to latest" : s.pill === "below" ? "↓ New messages" : "↓ Jump to latest";
  function onPill() {
    const st = ctl.state();
    if (st.pill === "history" || st.win.hasNewer) return void ctl.jump("latest");
    list.current?.scrollToOffset({ offset: 0, animated: true });
    ctl.dismissPill();
  }

  // ---------------------------------------------------------------- not found / gone

  if (lost) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <Header left={<IconButton icon="←" label="Back to rooms" onPress={() => router.back()} />} title="" />
        <View style={{ padding: 24, gap: 12 }}>
          <Text accessibilityRole="header" style={{ color: t.fg, fontSize: 22, fontWeight: "800" }}>
            {gone ? "You can't see this room any more." : "This room doesn't exist."}
          </Text>
          {!me && !gone ? <Text style={{ color: t.muted }}>Log in to see more rooms.</Text> : null}
          <View style={[styles.row, { gap: 8 }]}>
            {!me && !gone ? <Button label="Log in" kind="primary" onPress={() => router.push("/login")} /> : null}
            <Button label={me ? "Back to rooms" : "Open Air rooms"} onPress={() => router.dismissTo("/")} />
          </View>
        </View>
      </View>
    );
  }

  // ---------------------------------------------------------------- header

  const title = room ? roomTitle(room, me) : "";
  const other = room ? otherMember(room, me) : undefined;
  const vis = room && !other ? visibilityOf(room) : "public";
  const mine = !!room && room.created_by === me?.id;

  function roomItems(): MenuItem[] {
    const jump: MenuItem = { label: "Jump to beginning", run: () => void ctl.jump("first") };
    if (!room) return [jump];
    if (room.kind === "dm") {
      return [
        hidden
          ? {
              label: "Reopen conversation",
              run: () => void actions.unhide(room.id).catch((e) => say(`That didn't work. ${errorMessage(e)}`)),
            }
          : {
              label: "Close conversation",
              run: () =>
                void actions.hide(room.id).then(
                  () => router.back(),
                  (e: unknown) => say(`That didn't work. ${errorMessage(e)}`),
                ),
            },
        jump,
      ];
    }
    if (!me) return [jump];
    const out: MenuItem[] = [];
    if (mine || visibilityOf(room) === "private")
      out.push({ label: mine ? "Room access…" : `Members (${room.members?.length ?? 0})`, run: () => setAccessOpen(true) });
    const fail = (e: unknown) => say(`That didn't work. ${errorMessage(e)}`);
    if (!room.archived || hidden)
      out.push(
        hidden
          ? { label: "Unhide room", run: () => void actions.unhide(room.id).catch(fail) }
          : { label: "Hide room", run: () => void actions.hide(room.id).catch(fail) },
      );
    if (mine)
      out.push(
        room.archived
          ? { label: "Unarchive room", run: () => void actions.setArchived(room.id, false).catch(fail) }
          : {
              label: "Archive room",
              confirm: { text: `Archive “${room.name}”? It becomes read-only for everyone.`, action: "Archive" },
              run: () => void actions.setArchived(room.id, true).catch(fail),
            },
      );
    out.push(jump);
    return out;
  }

  const header = selected ? (
    <Header
      left={<IconButton icon="×" label="Stop selecting" onPress={endSelect} />}
      title={<Text style={{ color: t.fg, fontSize: 18, fontWeight: "800" }}>{selected.size} selected</Text>}
    />
  ) : (
    <Header
      left={<IconButton icon="←" label="Back to rooms" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />}
      title={
        <View style={[styles.row, { gap: 8 }]}>
          {other ? <Avatar user={other} size={30} url={api.avatarUrl} /> : null}
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: t.fg, fontSize: 18, fontWeight: "800", flexShrink: 1 }}>
            {title}
          </Text>
          {vis !== "public" ? (
            <Text
              style={{
                color: t.muted,
                fontSize: 12,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: 999,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              {VISIBILITY[vis].icon} {VISIBILITY[vis].label}
            </Text>
          ) : null}
        </View>
      }
      right={<IconButton icon="⋯" label="Room actions" onPress={() => setRoomMenu(true)} />}
    />
  );

  // ---------------------------------------------------------------- footer

  function footer() {
    if (!room || s.phase === "failed") return null;
    if (selected) {
      const ids = [...selected];
      const allMine = ids.length > 0 && ids.every((id) => ctl.deletable(ctl.find(id)!));
      return (
        <View style={[styles.row, { gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: t.border, paddingBottom: 10 + bottomInset }]}>
          <Button label="Forward" kind="primary" onPress={() => setForwarding(ids)} />
          {allMine ? <Button label="Delete" kind="danger" onPress={() => setConfirmDelete(true)} /> : null}
          <View style={{ flex: 1 }} />
          <Button label="Cancel" onPress={endSelect} />
        </View>
      );
    }
    if (room.archived) return banner("This room is archived. History is read-only.");
    if (!me) {
      return (
        <View style={{ padding: 12, paddingBottom: 12 + bottomInset, borderTopWidth: 1, borderTopColor: t.border, gap: 8 }}>
          <Text style={{ color: t.muted }}>You're reading as a guest. Log in or sign up to join the conversation.</Text>
          <View style={[styles.row, { gap: 8 }]}>
            <Button label="Log in" small onPress={() => router.push("/login")} />
            <Button label="Sign up" small kind="primary" onPress={() => router.push({ pathname: "/login", params: { mode: "signup" } })} />
          </View>
        </View>
      );
    }
    const editMessage = editing ? ctl.find(editing) : undefined;
    const quoted = replyNow ? { name: replyNow.expand?.author?.name ?? "Unknown", text: quoteText(replyNow) } : null;
    return (
      <View style={{ paddingBottom: bottomInset }}>
        <Composer
          ref={composer}
          placeholder={`Message ${title}`}
          initialText={drafts.get(roomId)}
          reply={quoted}
          editing={editMessage ? { id: editMessage.id, text: editMessage.text, hasFiles: !!editMessage.files?.length } : null}
          onSend={(text, files) => {
            if (!ctl.send(text, files, replyNow ?? undefined)) return false;
            setReplyTo(null);
            return true;
          }}
          onSaveEdit={(id, text) => void saveEdit(id, text)}
          onCancelEdit={() => setEditing(null)}
          onCancelReply={() => setReplyTo(null)}
          onChange={(text) => drafts.set(roomId, text)}
        />
      </View>
    );
  }

  function banner(text: string) {
    return (
      <Text
        style={{
          color: t.muted,
          textAlign: "center",
          padding: 14,
          paddingBottom: 14 + bottomInset,
          borderTopWidth: 1,
          borderTopColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        {text}
      </Text>
    );
  }

  // ---------------------------------------------------------------- message sheet

  function messageItems(m: Message): MenuItem[] {
    if (m.status === "failed")
      return [
        { label: "Retry", run: () => void ctl.retrySend(m.id) },
        { label: "Discard", run: () => ctl.discard(m.id), danger: true },
      ];
    const items: MenuItem[] = [];
    if (ctl.repliable(m))
      items.push({
        label: "Reply",
        run: () => {
          setEditing(null);
          setReplyTo(m);
          composer.current?.focus();
        },
      });
    if (ctl.selectable(m) && !emptyForward(m)) items.push({ label: "Forward", run: () => setForwarding([m.id]) });
    if (ctl.selectable(m)) items.push({ label: "Select", run: () => toggleSelect(m.id) });
    if (m.text && !m.deleted)
      items.push({ label: "Copy text", run: () => void Clipboard.setStringAsync(m.text).then(() => flash("Copied.")) });
    if (ctl.editable(m))
      items.push({
        label: "Edit",
        run: () => {
          setReplyTo(null);
          setEditing(m.id);
          setTimeout(() => composer.current?.focus(), 50);
        },
      });
    if (ctl.deletable(m))
      items.push({ label: "Delete", confirm: { text: "Delete this message?", action: "Delete message" }, run: () => void doDelete(m.id) });
    const author = m.expand?.author;
    if (me && author && author.id !== me.id && !author.no_dms)
      items.push({ label: `Message ${author.name}`, run: () => void messageUser(author.id) });
    return items;
  }

  const sheetMine =
    sheet && me ? new Set(ctl.reactions(sheet).flatMap((r) => (r.users.includes(me.id) ? [r.emoji] : []))) : new Set<string>();
  const reactMsg = reactFor ? ctl.find(reactFor) : undefined;
  const reactMine =
    reactMsg && me ? new Set(ctl.reactions(reactMsg).flatMap((r) => (r.users.includes(me.id) ? [r.emoji] : []))) : new Set<string>();

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="padding">
      {header}
      {notice ? (
        <Pressable
          onPress={() => say("")}
          accessibilityRole="alert"
          style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: t.surface }}
        >
          <Text style={{ color: t.fg }}>{notice}</Text>
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        {s.phase === "failed" ? (
          <View style={{ padding: 24, alignItems: "center", gap: 12 }}>
            <Text style={{ color: t.fg, textAlign: "center" }}>Couldn't load this room. Check your connection.</Text>
            <Button label="Retry" onPress={() => ctl.retry()} />
          </View>
        ) : s.phase === "loading" && !s.win.items.length ? (
          <ActivityIndicator style={{ marginTop: 32 }} color={t.accent} />
        ) : (
          <FlatList
            ref={list}
            inverted
            data={rows}
            extraData={[selected, editing, uploads, s.targetId]}
            keyExtractor={(r) => r.key}
            renderItem={renderRow}
            onScroll={onScroll}
            scrollEventThrottle={50}
            onEndReached={() => void ctl.loadEdge("top")}
            onEndReachedThreshold={0.5}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            removeClippedSubviews={Platform.OS === "android"}
            windowSize={11}
            onScrollToIndexFailed={(info) => {
              list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
              setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: false }), 120);
            }}
            ListFooterComponent={s.win.hasOlder ? <ActivityIndicator style={{ padding: 16 }} color={t.accent} /> : null}
            ListHeaderComponent={
              s.win.hasNewer ? <ActivityIndicator style={{ padding: 16 }} color={t.accent} /> : <View style={{ height: 8 }} />
            }
          />
        )}
        {pillShown ? (
          <Pressable
            onPress={onPill}
            accessibilityRole="button"
            style={{
              position: "absolute",
              bottom: 12,
              alignSelf: "center",
              backgroundColor: t.accent,
              borderRadius: 999,
              paddingHorizontal: 16,
              paddingVertical: 9,
              elevation: 4,
              shadowColor: "#000",
              shadowOpacity: 0.2,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 3 },
            }}
          >
            <Text style={{ color: t.onAccent, fontWeight: "800" }}>{pillText}</Text>
          </Pressable>
        ) : null}
      </View>
      {footer()}

      <MenuSheet visible={roomMenu} onClose={() => setRoomMenu(false)} title={title} items={roomItems()} />
      <MenuSheet
        visible={!!sheet}
        onClose={() => setSheet(null)}
        title={sheet ? `${sheet.expand?.author?.name ?? ""}: ${quoteText(sheet).slice(0, 80)}` : undefined}
        items={sheet ? messageItems(sheet) : []}
        header={
          sheet && ctl.reactable(sheet) && sheet.status !== "failed" ? (
            <View style={[styles.row, { justifyContent: "space-around", paddingHorizontal: 12, paddingBottom: 8 }]}>
              {quick.map((e) => (
                <Pressable
                  key={e}
                  onPress={() => {
                    const id = sheet.id;
                    setSheet(null);
                    void react(id, e, !sheetMine.has(e));
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={sheetMine.has(e) ? `Remove ${e}` : `React ${e}`}
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: 23,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: sheetMine.has(e) ? t.tint : t.surface,
                  }}
                >
                  <Text style={{ fontSize: 24 }}>{e}</Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => {
                  const id = sheet.id;
                  setSheet(null);
                  setReactFor(id);
                }}
                accessibilityRole="button"
                accessibilityLabel="More reactions"
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 23,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: t.surface,
                }}
              >
                <Text style={{ fontSize: 22, color: t.muted }}>＋</Text>
              </Pressable>
            </View>
          ) : null
        }
      />
      <MenuSheet
        visible={!!authorSheet}
        onClose={() => setAuthorSheet(null)}
        title={authorSheet?.name}
        items={authorSheet ? [{ label: `Message ${authorSheet.name}`, run: () => void messageUser(authorSheet.id) }] : []}
      />
      <MenuSheet
        visible={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={selected?.size === 1 ? "Delete this message?" : `Delete these ${selected?.size ?? 0} messages?`}
        items={[
          { label: "Delete", danger: true, run: () => void deleteSelected([...(selected ?? [])]) },
          { label: "Cancel", run: () => {} },
        ]}
      />
      <EmojiPicker
        visible={!!reactFor}
        title="Add reaction"
        chosen={reactMine}
        onPick={(e) => reactFor && void react(reactFor, e, !reactMine.has(e))}
        onClose={() => setReactFor(null)}
      />
      <ForwardSheet count={forwarding.length} onPick={forwardTo} onClose={() => setForwarding([])} />
      <AccessSheet room={accessOpen ? (room ?? null) : null} me={me} onClose={() => setAccessOpen(false)} />
      {viewer ? <Viewer {...viewer} /> : null}
    </KeyboardAvoidingView>
  );
}

/** The window as list rows, newest first (the list is inverted): day dividers, author groups, the "New" line. */
function useRows(s: ReturnType<ReturnType<typeof createRoomController>["state"]>, beginning: string): Row[] {
  const { win, unreadId, phase } = s;
  return useMemo(() => {
    const rows: Row[] = [];
    if (!win.hasOlder && phase === "ready") rows.push({ kind: "begin", key: "begin", text: beginning });
    let prev: Message | undefined;
    let prevDay = "";
    for (const m of win.items) {
      const ms = parsePb(m.created);
      const day = new Date(ms).toDateString();
      const newDay = day !== prevDay;
      if (newDay) rows.push({ kind: "day", key: `day-${day}`, label: dayLabel(ms) });
      if (m.id === unreadId) rows.push({ kind: "new", key: "new-line" });
      if (!m.author) rows.push({ kind: "service", key: m.id, m });
      else {
        const quoted: Quoted | null = m.reply_to
          ? (win.items.find((x) => x.id === m.reply_to) ?? m.expand?.reply_to ?? { id: m.reply_to, author: "", text: "", deleted: true })
          : null;
        rows.push({ kind: "msg", key: m.id, m, groupStart: newDay || startsGroup(prev, m), quoted });
      }
      prev = m;
      prevDay = day;
    }
    return rows.reverse();
  }, [win, unreadId, phase, beginning]);
}
