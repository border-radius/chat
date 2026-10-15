// The composer (web views/room/composer.ts, §7.6, §17.4): a growing text field with a character counter, attachments
// (gallery, camera, files) in a tray above it, the message being replied to (§19), emoji (§20.4), and editing your
// own message (§7.6.1), which on a phone happens here rather than in the message itself.

import { Image } from "expo-image";
import { type Ref, useImperativeHandle, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { NativeFile } from "../core/client";
import { nativeOf, pickDocuments, pickMedia, previewable, takePhoto, toLocal } from "../core/files";
import { checkFiles, editProblem, formatBytes, LIMITS, type LocalFile, textLength, validEdit } from "../shared";
import { IconButton, MenuSheet, styles } from "../ui/components";
import { useTheme } from "../ui/theme";
import { EmojiPicker } from "./EmojiPicker";

const MAX_LEN = LIMITS.messageText;
const COUNTER_FROM = 1800;

export interface ComposerHandle {
  setText(text: string): void;
  focus(): void;
}

export function Composer({
  ref,
  placeholder,
  initialText,
  reply,
  editing,
  onSend,
  onSaveEdit,
  onCancelReply,
  onCancelEdit,
  onChange,
}: {
  ref?: Ref<ComposerHandle>;
  placeholder: string;
  initialText: string;
  reply: { name: string; text: string } | null;
  /** Editing one of your messages: its text, and whether it has attachments (then the text may be empty). */
  editing: { id: string; text: string; hasFiles: boolean } | null;
  /** Trimmed text and the attachments. False: refused, everything stays. */
  onSend: (text: string, files: LocalFile[]) => boolean;
  onSaveEdit: (id: string, text: string) => void;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onChange: (text: string) => void;
}) {
  const t = useTheme();
  const [text, setTextState] = useState(initialText);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [trayError, setTrayError] = useState("");
  const [preparing, setPreparing] = useState(0);
  const [attachMenu, setAttachMenu] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [hint, setHint] = useState("");
  const input = useRef<TextInput>(null);
  const selection = useRef({ start: initialText.length, end: initialText.length });
  /** What was typed before an edit started: back once it ends. */
  const draft = useRef<string | null>(null);
  const editingId = useRef<string | null>(null);

  const setText = (v: string, persist = true) => {
    setTextState(v);
    setHint("");
    if (persist && !editingId.current) onChange(v);
  };

  // An edit started or ended (render-time sync with the `editing` prop).
  if ((editing?.id ?? null) !== editingId.current) {
    if (editing && !editingId.current) draft.current = text;
    const back = !editing && editingId.current ? (draft.current ?? "") : null;
    editingId.current = editing?.id ?? null;
    if (editing) {
      setTextState(editing.text);
      selection.current = { start: editing.text.length, end: editing.text.length };
    } else if (back !== null) {
      setTextState(back);
      draft.current = null;
    }
  }

  useImperativeHandle(ref, () => ({
    setText: (v) => setText(v, false),
    focus: () => input.current?.focus(),
  }));

  async function add(picked: NativeFile[]) {
    if (!picked.length) return;
    const { accepted, rejected } = checkFiles(
      files.map((f) => f.file),
      picked as unknown as File[],
    );
    setFiles((fs) => [...fs, ...accepted.map((f) => toLocal(f as unknown as NativeFile))]);
    setTrayError(rejected.map((r) => `“${r.name}”: ${r.reason}.`).join(" "));
  }

  async function attach(source: () => Promise<NativeFile[]>) {
    setPreparing((n) => n + 1);
    try {
      await add(await source());
    } catch (e) {
      setTrayError((e as Error).message || "Couldn't attach that.");
    } finally {
      setPreparing((n) => n - 1);
    }
  }

  const len = textLength(text.trim());
  const sendable = editing ? validEdit(text, editing.hasFiles) : validEdit(text, files.length > 0);
  const counter = len <= COUNTER_FROM ? "" : len <= MAX_LEN ? `${MAX_LEN - len} left` : `${len - MAX_LEN} over`;

  function submit() {
    if (editing) {
      const problem = editProblem(text, editing.hasFiles);
      if (problem) return setHint(problem);
      onSaveEdit(editing.id, text);
      return;
    }
    if (sendable === null || preparing > 0 || !onSend(sendable, files)) return;
    setText("");
    setFiles([]);
    setTrayError("");
  }

  function insertEmoji(e: string) {
    const { start, end } = selection.current;
    const next = text.slice(0, start) + e + text.slice(end);
    setText(next);
    selection.current = { start: start + e.length, end: start + e.length };
    setTimeout(() => input.current?.focus(), 50);
  }

  const bar = (label: string, body: string, onCancel: () => void, cancelLabel: string) => (
    <View
      style={[
        styles.row,
        { gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderLeftWidth: 3, borderLeftColor: t.accent, backgroundColor: t.surface },
      ]}
    >
      <Text style={{ flex: 1, color: t.fg }} numberOfLines={1}>
        <Text style={{ fontWeight: "800" }}>{label}</Text>
        {body ? <Text style={{ color: t.muted }}> {body}</Text> : null}
      </Text>
      <IconButton icon="×" label={cancelLabel} onPress={onCancel} size={30} />
    </View>
  );

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.bg }}>
      {editing
        ? bar("Editing message", "", onCancelEdit, "Cancel edit")
        : reply
          ? bar(`Replying to ${reply.name}`, reply.text, onCancelReply, "Cancel reply")
          : null}
      {files.length && !editing ? (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 8, padding: 8 }}
          accessibilityLabel="Attachments"
        >
          {files.map((lf) => {
            const f = nativeOf(lf);
            return (
              <View
                key={f.uri}
                style={[
                  styles.row,
                  { gap: 6, padding: 6, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.raised, maxWidth: 220 },
                ]}
              >
                {previewable(f) && f.type.startsWith("image/") ? (
                  <Image source={{ uri: f.uri }} style={{ width: 40, height: 40, borderRadius: 6 }} contentFit="cover" />
                ) : (
                  <Text style={{ fontSize: 22 }}>{f.type.startsWith("video/") ? "🎬" : "📄"}</Text>
                )}
                <View style={{ flexShrink: 1 }}>
                  <Text style={{ color: t.fg, fontSize: 13 }} numberOfLines={1}>
                    {f.name}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 12 }}>{formatBytes(f.size)}</Text>
                </View>
                <IconButton icon="×" label={`Remove ${f.name}`} size={28} onPress={() => setFiles((fs) => fs.filter((x) => x !== lf))} />
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      {trayError ? <Text style={{ color: t.danger, paddingHorizontal: 12, paddingTop: 6 }}>{trayError}</Text> : null}
      {hint ? <Text style={{ color: t.danger, paddingHorizontal: 12, paddingTop: 6 }}>{hint}</Text> : null}
      <View style={[styles.row, { alignItems: "flex-end", gap: 4, paddingHorizontal: 6, paddingVertical: 6 }]}>
        {!editing ? (
          <IconButton icon="+" label="Attach files" onPress={() => setAttachMenu(true)} disabled={files.length >= LIMITS.attachments} />
        ) : null}
        <View
          style={{ flex: 1, borderRadius: 20, borderWidth: 1, borderColor: t.border, backgroundColor: t.raised, paddingHorizontal: 14 }}
        >
          <TextInput
            ref={input}
            value={text}
            onChangeText={(v) => setText(v)}
            onSelectionChange={(e) => (selection.current = e.nativeEvent.selection)}
            placeholder={placeholder}
            placeholderTextColor={t.muted}
            accessibilityLabel="Message"
            multiline
            style={{ color: t.fg, fontSize: 16, minHeight: 40, maxHeight: 6 * 22 + 16, paddingTop: 9, paddingBottom: 9 }}
          />
        </View>
        {counter ? <Text style={{ color: len > MAX_LEN ? t.danger : t.muted, fontSize: 12, alignSelf: "center" }}>{counter}</Text> : null}
        <IconButton icon="☺" label="Emoji" onPress={() => setEmoji(true)} />
        <IconButton
          icon={editing ? "✓" : "➤"}
          label={editing ? "Save edit" : "Send"}
          filled
          disabled={editing ? false : sendable === null || preparing > 0}
          onPress={submit}
        />
      </View>
      <MenuSheet
        visible={attachMenu}
        onClose={() => setAttachMenu(false)}
        title="Attach"
        items={[
          { label: "Photos and videos", run: () => void attach(() => pickMedia(LIMITS.attachments - files.length)) },
          { label: "Take a photo", run: () => void attach(async () => [await takePhoto()].filter((f): f is NativeFile => !!f)) },
          { label: "Files", run: () => void attach(pickDocuments) },
        ]}
      />
      <EmojiPicker visible={emoji} title="Insert emoji" onPick={insertEmoji} onClose={() => setEmoji(false)} />
    </View>
  );
}
