// One message (web views/room/messages.ts, §7.5): author and time at the start of a group, "Forwarded from", the quote
// it replies to (§19), its text with links (§7.6.3), "(edited)", attachments (§17.5), reactions (§20.3), and why it
// wasn't sent. Long press for its actions; while selecting (§21.1), a tap selects it. Redrawn only when what it shows
// changes (`sig`).

import { Image } from "expo-image";
import { memo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { nativeOf, previewable } from "../core/files";
import {
  attachmentName,
  emptyForward,
  formatBytes,
  isAudio,
  isMedia,
  isVideo,
  linkify,
  type Message,
  type Quoted,
  quoteText,
  type Reaction,
  type User,
} from "../shared";
import { Avatar, styles } from "../ui/components";
import type { Theme } from "../ui/theme";

export const MAX_TILES = 4;

export type ShownReaction = Reaction & { who: string };

export interface MsgError {
  text: string;
  retry: () => void;
}

/** What a message does when touched: the room screen's, the same object for every message. */
export interface MessageUi {
  t: Theme;
  me: () => User | null;
  avatarUrl: (u: User, px: 48 | 96) => string;
  fileUrl: (m: Message, file: string, thumb?: string) => string;
  refreshFileToken: () => Promise<unknown>;
  onPress: (m: Message) => void;
  onLongPress: (m: Message) => void;
  onOpenQuote: (id: string) => void;
  onReact: (id: string, emoji: string, on: boolean) => void;
  onReactionInfo: (r: ShownReaction) => void;
  onPickReaction: (id: string) => void;
  onRetrySend: (id: string) => void;
  onDiscard: (id: string) => void;
  onOpenMedia: (m: Message, file: string) => void;
  onOpenFile: (m: Message, file: string) => void;
  onAuthor: (u: User) => void;
  onLink: (href: string) => void;
}

export interface MessageProps {
  m: Message;
  /** What it shows, as a string: redrawn only when this changes. */
  sig: string;
  groupStart: boolean;
  quoted: Quoted | null;
  target: boolean;
  /** Selecting: whether this one is selected; null when it can't be or when not selecting. */
  picked: boolean | null;
  selecting: boolean;
  reactions: ShownReaction[];
  reactable: boolean;
  time: string;
  fullTime: string;
  edited: string;
  error: MsgError | undefined;
  upload: number;
  ui: MessageUi;
}

export const MessageItem = memo(
  function MessageItem(p: MessageProps) {
    const { m, ui } = p;
    const { t } = ui;
    const me = ui.me();
    const author: User = m.expand?.author ?? (me && m.author === me.id ? me : { id: m.author, name: "Unknown" });
    const gone = m.deleted || emptyForward(m);
    const pending = m.status === "pending";
    return (
      <Pressable
        onPress={() => ui.onPress(m)}
        onLongPress={() => ui.onLongPress(m)}
        delayLongPress={300}
        accessibilityHint={p.selecting ? undefined : "Long press for actions"}
        accessibilityState={p.picked !== null ? { checked: p.picked } : {}}
        style={({ pressed }) => [
          {
            flexDirection: "row",
            paddingHorizontal: 12,
            paddingTop: p.groupStart ? 10 : 2,
            paddingBottom: 2,
            backgroundColor: p.target ? t.highlight : p.picked ? t.tint : pressed ? t.hover : "transparent",
            opacity: pending ? 0.65 : 1,
          },
        ]}
      >
        {p.picked !== null ? (
          <View
            style={[
              styles.center,
              {
                width: 24,
                height: 24,
                borderRadius: 12,
                borderWidth: 2,
                marginRight: 8,
                marginTop: p.groupStart ? 8 : 2,
                borderColor: t.accent,
                backgroundColor: p.picked ? t.accent : "transparent",
              },
            ]}
          >
            {p.picked ? <Text style={{ color: t.onAccent, fontWeight: "900", fontSize: 13 }}>✓</Text> : null}
          </View>
        ) : null}
        <View style={{ width: 40, marginRight: 10 }}>
          {p.groupStart ? (
            <Pressable onPress={() => ui.onAuthor(author)} accessibilityLabel={author.name} disabled={p.selecting}>
              <Avatar user={author} size={40} url={ui.avatarUrl} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {p.groupStart ? (
            <View style={[styles.row, { gap: 8, marginBottom: 2 }]}>
              <Text
                onPress={p.selecting ? undefined : () => ui.onAuthor(author)}
                style={{ color: t.fg, fontWeight: "800", fontSize: 15, flexShrink: 1 }}
                numberOfLines={1}
              >
                {author.name}
              </Text>
              <Text style={{ color: t.muted, fontSize: 12 }} accessibilityLabel={p.fullTime}>
                {p.time}
              </Text>
            </View>
          ) : null}
          {m.forwarded_from && !m.deleted ? (
            <Text style={{ color: t.muted, fontSize: 13, fontStyle: "italic", marginBottom: 2 }}>
              Forwarded from {m.expand?.forwarded_from?.name ?? "Unknown"}
            </Text>
          ) : null}
          {p.quoted ? <Quote q={p.quoted} t={t} onPress={() => ui.onOpenQuote(p.quoted!.id)} disabled={p.selecting} /> : null}
          {gone ? (
            <Text style={{ color: t.muted, fontStyle: "italic", fontSize: 15 }}>
              {m.deleted ? "Message deleted" : "The original message was deleted"}
            </Text>
          ) : m.text ? (
            <Text style={{ color: t.fg, fontSize: 16, lineHeight: 22 }} selectable={!p.selecting}>
              {linkify(m.text).map((part, i) =>
                typeof part === "string" ? (
                  part
                ) : (
                  <Text
                    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text, in order; they never move
                    key={i}
                    style={{ color: t.accent, textDecorationLine: "underline" }}
                    onPress={p.selecting ? undefined : () => ui.onLink(part.href)}
                    accessibilityRole="link"
                  >
                    {part.text}
                  </Text>
                ),
              )}
              {m.edited_at && !m.deleted ? (
                <Text style={{ color: t.muted, fontSize: 12 }} accessibilityLabel={`Edited ${p.edited}`}>
                  {"  (edited)"}
                </Text>
              ) : null}
            </Text>
          ) : m.edited_at && !m.deleted ? (
            <Text style={{ color: t.muted, fontSize: 12 }}>(edited)</Text>
          ) : null}
          {!m.deleted ? <Attachments m={m} upload={p.upload} ui={ui} selecting={p.selecting} /> : null}
          {p.reactions.length ? <Reactions m={m} list={p.reactions} reactable={p.reactable && !p.selecting} ui={ui} /> : null}
          {m.status === "failed" ? (
            <View style={[styles.row, { gap: 12, marginTop: 4, flexWrap: "wrap" }]}>
              <Text style={{ color: t.danger }}>
                {p.quoted?.deleted ? "Not sent: the message you replied to was deleted." : "Not sent."}
              </Text>
              <Text style={{ color: t.accent, fontWeight: "700" }} onPress={() => ui.onRetrySend(m.id)} accessibilityRole="button">
                {p.quoted?.deleted ? "Send without quote" : "Retry"}
              </Text>
              <Text style={{ color: t.accent, fontWeight: "700" }} onPress={() => ui.onDiscard(m.id)} accessibilityRole="button">
                Discard
              </Text>
            </View>
          ) : null}
          {p.error ? (
            <View style={[styles.row, { gap: 12, marginTop: 4 }]} accessibilityRole="alert">
              <Text style={{ color: t.danger, flexShrink: 1 }}>{p.error.text}</Text>
              <Text style={{ color: t.accent, fontWeight: "700" }} onPress={p.error.retry} accessibilityRole="button">
                Retry
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    );
  },
  (a, b) => a.sig === b.sig && a.ui === b.ui && a.upload === b.upload,
);

/** A service message (§5.3): one line of the app's own, nobody's, with no actions. */
export function ServiceLine({ text, time, t }: { text: string; time: string; t: Theme }) {
  return (
    <Text style={{ color: t.muted, textAlign: "center", fontSize: 13, paddingVertical: 6, paddingHorizontal: 24 }}>
      {text} · {time}
    </Text>
  );
}

function Quote({ q, t, onPress, disabled }: { q: Quoted; t: Theme; onPress: () => void; disabled: boolean }) {
  const name = q.expand?.author?.name ?? "";
  const text = quoteText(q);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Quoting ${name || "a message"}: ${text.slice(0, 80)}. Show the original message.`}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: t.accent,
        backgroundColor: t.surface,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        marginBottom: 4,
      }}
    >
      {name ? <Text style={{ color: t.accent, fontWeight: "700", fontSize: 13 }}>{name}</Text> : null}
      <Text numberOfLines={1} style={{ color: q.deleted ? t.muted : t.fg, fontStyle: q.deleted ? "italic" : "normal", fontSize: 14 }}>
        {text}
      </Text>
    </Pressable>
  );
}

function Reactions({ m, list, reactable, ui }: { m: Message; list: ShownReaction[]; reactable: boolean; ui: MessageUi }) {
  const { t } = ui;
  const me = ui.me()?.id ?? "";
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
      {list.map((r) => {
        const mine = r.users.includes(me);
        return (
          <Pressable
            key={r.emoji}
            onPress={() => (reactable ? ui.onReact(m.id, r.emoji, !mine) : ui.onReactionInfo(r))}
            onLongPress={() => ui.onReactionInfo(r)}
            accessibilityRole="button"
            accessibilityLabel={`${r.emoji} ${r.users.length}: ${r.who}`}
            accessibilityState={{ selected: mine }}
            style={[
              styles.row,
              {
                gap: 4,
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: mine ? t.accent : t.border,
                backgroundColor: mine ? t.tint : t.raised,
              },
            ]}
          >
            <Text style={{ fontSize: 15 }}>{r.emoji}</Text>
            <Text style={{ color: mine ? t.accent : t.muted, fontWeight: "700", fontSize: 13 }}>{r.users.length}</Text>
          </Pressable>
        );
      })}
      {reactable ? (
        <Pressable
          onPress={() => ui.onPickReaction(m.id)}
          accessibilityRole="button"
          accessibilityLabel="Add reaction"
          style={{
            paddingHorizontal: 10,
            paddingVertical: 3,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.raised,
          }}
        >
          <Text style={{ color: t.muted, fontSize: 15 }}>☺+</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * A message's attachments (§17.5): images and videos as tiles (1 large, or a row of up to 4, the 4th saying "+N"),
 * other files (audio too) as chips. A message not yet on the server shows its local files, with upload progress.
 */
function Attachments({ m, upload, ui, selecting }: { m: Message; upload: number; ui: MessageUi; selecting: boolean }) {
  const { t } = ui;
  const local = m.localFiles ?? [];
  const names = m.files ?? [];
  if (!local.length && !names.length) return null;

  if (local.length) {
    const files = local.map(nativeOf);
    const pics = files.filter((f) => previewable(f) && !isVideo(f.name));
    const others = files.filter((f) => !pics.includes(f));
    return (
      <View style={{ marginTop: 4, gap: 4 }}>
        {pics.length ? (
          <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
            {pics.slice(0, MAX_TILES).map((f) => (
              <Image
                key={f.uri}
                source={{ uri: f.uri }}
                style={{ width: pics.length === 1 ? 220 : 72, height: pics.length === 1 ? 160 : 72, borderRadius: 10 }}
                contentFit="cover"
              />
            ))}
          </View>
        ) : null}
        {others.map((f) => (
          <Chip key={f.uri} t={t} icon={isVideo(f.name) ? "🎬" : "📄"} name={f.name} size={formatBytes(f.size)} />
        ))}
        {m.status === "pending" ? (
          <View
            style={{ height: 4, borderRadius: 2, backgroundColor: t.border, overflow: "hidden", maxWidth: 240 }}
            accessibilityLabel="Uploading"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(upload * 100) }}
          >
            <View style={{ width: `${Math.round(upload * 100)}%`, height: 4, backgroundColor: t.accent }} />
          </View>
        ) : null}
      </View>
    );
  }

  const media = names.filter(isMedia);
  const others = names.filter((n) => !isMedia(n));
  const one = media.length === 1;
  return (
    <View style={{ marginTop: 4, gap: 4 }}>
      {media.length ? (
        <View style={{ flexDirection: "row", gap: 4 }}>
          {media.slice(0, MAX_TILES).map((name, i) => (
            <Tile
              key={name}
              m={m}
              name={name}
              ui={ui}
              one={one}
              more={i === MAX_TILES - 1 && media.length > MAX_TILES ? media.length - MAX_TILES : 0}
              disabled={selecting}
            />
          ))}
        </View>
      ) : null}
      {others.map((name) => (
        <Chip
          key={name}
          t={t}
          icon={isAudio(name) ? "♪" : "📄"}
          name={attachmentName(m, name)}
          onPress={selecting ? undefined : () => (isAudio(name) ? ui.onOpenMedia(m, name) : ui.onOpenFile(m, name))}
        />
      ))}
    </View>
  );
}

function Chip({
  t,
  icon,
  name,
  size,
  onPress,
}: {
  t: Theme;
  icon: string;
  name: string;
  size?: string;
  onPress?: (() => void) | undefined;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? `Open ${name}` : name}
      style={({ pressed }) => [
        styles.row,
        {
          gap: 8,
          alignSelf: "flex-start",
          maxWidth: "100%",
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: pressed ? t.hover : t.raised,
        },
      ]}
    >
      <Text style={{ fontSize: 16 }}>{icon}</Text>
      <Text style={{ color: onPress ? t.accent : t.fg, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
        {name}
      </Text>
      {size ? <Text style={{ color: t.muted, fontSize: 12 }}>{size}</Text> : null}
    </Pressable>
  );
}

/** An image's thumbnail (or a video's tile): tap to view. A failed load retries once with a fresh file token. */
function Tile({
  m,
  name,
  ui,
  one,
  more,
  disabled,
}: {
  m: Message;
  name: string;
  ui: MessageUi;
  one: boolean;
  more: number;
  disabled: boolean;
}) {
  const { t } = ui;
  const video = isVideo(name);
  const thumb = one ? "800x480f" : "480x240f";
  const [src, setSrc] = useState(() => (video ? "" : ui.fileUrl(m, name, thumb)));
  const [ratio, setRatio] = useState(one ? 4 / 3 : 1);
  const [broken, setBroken] = useState(false);
  const retried = useRef(false);
  const h = one ? 200 : 84;
  const w = one ? Math.min(280, Math.max(120, h * ratio)) : 84;
  return (
    <Pressable
      onPress={() => ui.onOpenMedia(m, name)}
      disabled={disabled}
      accessibilityRole="imagebutton"
      accessibilityLabel={`${attachmentName(m, name)}${video ? ", video" : ""}`}
      style={{ width: w, height: h, borderRadius: 10, overflow: "hidden", backgroundColor: t.surface }}
    >
      {video ? (
        <View style={[styles.center, { flex: 1, backgroundColor: "#111" }]}>
          <Text style={{ color: "#fff", fontSize: 28 }}>▶</Text>
          {one ? (
            <Text style={{ color: "#ccc", fontSize: 12, paddingHorizontal: 8 }} numberOfLines={1}>
              {attachmentName(m, name)}
            </Text>
          ) : null}
        </View>
      ) : broken ? (
        <View style={[styles.center, { flex: 1, padding: 6 }]}>
          <Text style={{ color: t.muted, fontSize: 12, textAlign: "center" }}>Couldn't load image</Text>
          <Text
            style={{ color: t.accent, fontWeight: "700", marginTop: 4 }}
            onPress={() => {
              retried.current = false;
              setBroken(false);
              setSrc(ui.fileUrl(m, name, thumb));
            }}
          >
            Retry
          </Text>
        </View>
      ) : (
        <Image
          source={{ uri: src }}
          style={{ width: "100%", height: "100%" }}
          contentFit="cover"
          recyclingKey={`${m.id}/${name}`}
          transition={120}
          onLoad={(e) => one && e.source.height && setRatio(e.source.width / e.source.height)}
          onError={() => {
            if (retried.current) return setBroken(true);
            retried.current = true;
            void ui.refreshFileToken().then(
              () => setSrc(ui.fileUrl(m, name, thumb)),
              () => setBroken(true),
            );
          }}
        />
      )}
      {more ? (
        <View style={[styles.center, { position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.5)" }]}>
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: "800" }}>+{more}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
