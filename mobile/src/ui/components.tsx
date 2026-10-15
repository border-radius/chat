// Building blocks shared by the screens: avatars (§15.4), buttons, fields, the bottom-sheet menu (the web's action
// menus), a screen header, and a confirm step.

import { Image } from "expo-image";
import { type ReactNode, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { avatarColor, initials, type User } from "../shared";
import { Sheet as HostedSheet } from "./sheets";
import { AVATAR_COLORS, type Theme, useTheme } from "./theme";

// ---------------------------------------------------------------- avatar

export function Avatar({ user, size, url }: { user: User; size: number; url: (u: User, px: 48 | 96) => string }) {
  const src = user.avatar ? url(user, size > 48 ? 96 : 48) : "";
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (src) return <Image source={{ uri: src }} style={box} contentFit="cover" accessibilityIgnoresInvertColors />;
  return (
    <View style={[box, styles.center, { backgroundColor: AVATAR_COLORS[avatarColor(user.id)] }]} accessibilityElementsHidden>
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: Math.round(size * 0.38) }}>{initials(user.name)}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- buttons

type Kind = "primary" | "plain" | "danger" | "link";

export function Button({
  label,
  onPress,
  kind = "plain",
  disabled,
  busy,
  style,
  small,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  kind?: Kind;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  style?: ViewStyle;
  small?: boolean;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const off = disabled || busy;
  const bg = kind === "primary" ? t.accent : kind === "danger" ? t.danger : kind === "link" ? "transparent" : t.raised;
  const fg = kind === "primary" || kind === "danger" ? t.onAccent : kind === "link" ? t.accent : t.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={!!off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        styles.button,
        small && styles.small,
        kind === "link" && styles.link,
        { backgroundColor: bg, borderColor: kind === "plain" ? t.border : bg, opacity: off ? 0.5 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

/** A round icon button (the composer's +, ☺ and send; header actions). */
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  filled,
  size = 40,
  color,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
  size?: number;
  /** The icon color, when it isn't on the theme background (the viewer). */
  color?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        styles.center,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: filled ? t.accent : pressed ? t.hover : "transparent",
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Text style={{ fontSize: size * 0.48, color: color ?? (filled ? t.onAccent : t.fg), fontWeight: "700" }}>{icon}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------- fields

export function Field({
  label,
  error,
  hint,
  ...input
}: TextInputProps & { label: string; error?: string | undefined; hint?: string | undefined }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.fg }]}>{label}</Text>
      <Input {...input} accessibilityLabel={label} invalid={!!error} />
      {error ? <Text style={[styles.error, { color: t.danger }]}>{error}</Text> : null}
      {!error && hint ? <Text style={[styles.hint, { color: t.muted }]}>{hint}</Text> : null}
    </View>
  );
}

export function Input({ invalid, style, ...props }: TextInputProps & { invalid?: boolean }) {
  const t = useTheme();
  return (
    <TextInput
      placeholderTextColor={t.muted}
      {...props}
      style={[styles.input, { color: t.fg, backgroundColor: t.raised, borderColor: invalid ? t.danger : t.border }, style]}
    />
  );
}

export function ErrorText({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const t = useTheme();
  if (!children) return null;
  return (
    <Text accessibilityRole="alert" style={[styles.error, { color: t.danger }, style]}>
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------- menu sheet

export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  /** Ask first: the sheet shows `text` with `action` and Cancel (§7.6.2). */
  confirm?: { text: string; action: string };
}

/** A bottom sheet of actions (the web's "…" menus and a message's buttons). `header`: shown above the items. */
export function MenuSheet({
  visible,
  onClose,
  title,
  items,
  header,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string | undefined;
  items: MenuItem[];
  header?: ReactNode;
}) {
  const t = useTheme();
  const [confirming, setConfirming] = useState<MenuItem | null>(null);
  const close = () => {
    setConfirming(null);
    onClose();
  };
  return (
    <Sheet visible={visible} onClose={close}>
      {title ? (
        <Text style={[styles.sheetTitle, { color: t.muted }]} numberOfLines={2}>
          {title}
        </Text>
      ) : null}
      {confirming?.confirm ? (
        <View style={styles.confirm}>
          <Text style={{ color: t.fg, fontSize: 16, marginBottom: 12 }}>{confirming.confirm.text}</Text>
          <View style={styles.row}>
            <Button
              label={confirming.confirm.action}
              kind="danger"
              onPress={() => {
                const run = confirming.run;
                close();
                run();
              }}
            />
            <Button label="Cancel" onPress={() => setConfirming(null)} style={{ marginLeft: 8 }} />
          </View>
        </View>
      ) : (
        <>
          {header}
          {items.map((item) => (
            <Pressable
              key={item.label}
              accessibilityRole="menuitem"
              onPress={() => {
                if (item.confirm) return setConfirming(item);
                close();
                item.run();
              }}
              style={({ pressed }) => [styles.menuItem, { backgroundColor: pressed ? t.hover : "transparent" }]}
            >
              <Text style={{ fontSize: 16, color: item.danger || item.confirm ? t.danger : t.fg }}>{item.label}</Text>
            </Pressable>
          ))}
        </>
      )}
    </Sheet>
  );
}

/** A panel sliding up from the bottom over a dimmed screen (ui/sheets.tsx); tapping outside or Back closes it. */
export function Sheet({
  visible,
  onClose,
  children,
  full,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Most of the screen's height (lists to pick from). */
  full?: boolean;
}) {
  return (
    <HostedSheet visible={visible} onClose={onClose} full={!!full}>
      {full ? children : <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>}
    </HostedSheet>
  );
}

// ---------------------------------------------------------------- header

/** A screen's top bar: back, title, and actions on the right. Draws under the status bar. */
export function Header({ left, title, right }: { left?: ReactNode; title: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 6, backgroundColor: t.bg, borderBottomColor: t.border }]}>
      {left}
      <View style={styles.headerTitle}>{typeof title === "string" ? <Title text={title} /> : title}</View>
      {right}
    </View>
  );
}

export function Title({ text }: { text: string }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" numberOfLines={1} style={{ color: t.fg, fontSize: 19, fontWeight: "800" }}>
      {text}
    </Text>
  );
}

export function Badge({ n, t }: { n: number; t: Theme }) {
  return (
    <View style={[styles.badge, { backgroundColor: t.accent }]} accessibilityLabel={`${n} unread`}>
      <Text style={{ color: t.onAccent, fontSize: 12, fontWeight: "800" }}>{n > 99 ? "99+" : n}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center" },
  button: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  small: { minHeight: 34, paddingHorizontal: 12 },
  link: { paddingHorizontal: 6, minHeight: 34 },
  buttonText: { fontWeight: "700", fontSize: 15 },
  field: { marginBottom: 14 },
  label: { fontWeight: "700", marginBottom: 6, fontSize: 14 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, minHeight: 46 },
  error: { marginTop: 6, fontSize: 14 },
  hint: { marginTop: 6, fontSize: 13 },
  sheetTitle: { paddingHorizontal: 20, paddingVertical: 8, fontSize: 14, fontWeight: "600" },
  menuItem: { paddingHorizontal: 20, paddingVertical: 14 },
  confirm: { paddingHorizontal: 20, paddingVertical: 12 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  headerTitle: { flex: 1, paddingHorizontal: 6, minHeight: 40, justifyContent: "center" },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
});
