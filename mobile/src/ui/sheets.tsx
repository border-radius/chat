// Bottom sheets (menus, pickers, forward, room access), drawn over the whole app from one host at the root rather than
// in a Modal window: in the app's own window they move up with the keyboard (Android draws edge-to-edge, so nothing
// resizes by itself), and they open and close as quickly as we say. Android's back button closes the top one.

import { createContext, Fragment, type ReactNode, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, BackHandler, Easing, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./theme";

const OPEN_MS = 180;
const CLOSE_MS = 140;

interface Host {
  set(id: string, node: ReactNode | null): void;
}

const HostCtx = createContext<Host | null>(null);

/** Where sheets are drawn: over everything inside it. */
export function SheetHost({ children }: { children: ReactNode }) {
  const [nodes, setNodes] = useState<ReadonlyMap<string, ReactNode>>(new Map());
  const host = useMemo<Host>(
    () => ({
      set(id, node) {
        setNodes((m) => {
          if (node === null && !m.has(id)) return m;
          const next = new Map(m);
          if (node === null) next.delete(id);
          else next.set(id, node);
          return next;
        });
      },
    }),
    [],
  );
  return (
    <HostCtx.Provider value={host}>
      {children}
      {[...nodes].map(([id, node]) => (
        <Fragment key={id}>{node}</Fragment>
      ))}
    </HostCtx.Provider>
  );
}

/** A panel sliding up from the bottom over a dimmed app; tapping outside or Back closes it. */
export function Sheet({
  visible,
  onClose,
  children,
  full,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  full?: boolean;
}) {
  const host = useContext(HostCtx);
  const id = useId();
  // Drawn by the host, with the latest content on every render of whoever declared it.
  useLayoutEffect(() => {
    host?.set(id, <SheetView visible={visible} onClose={onClose} full={!!full} content={children} />);
  });
  useEffect(() => () => host?.set(id, null), [host, id]);
  return null;
}

function SheetView({ visible, onClose, full, content }: { visible: boolean; onClose: () => void; full: boolean; content: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardState((s) => (s.isVisible ? s.height : 0));
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? OPEN_MS : CLOSE_MS,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => finished && !visible && setMounted(false));
  }, [visible, progress]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close.current();
      return true;
    });
    return () => sub.remove();
  }, [visible]);

  if (!mounted) return null;
  const room = height - keyboard - insets.top - 16;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [Math.min(400, height), 0] });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? "auto" : "none"}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.4)", opacity: progress }]}>
        <Pressable style={{ flex: 1 }} onPress={() => close.current()} accessibilityLabel="Close" accessibilityRole="button" />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          {
            bottom: keyboard,
            maxHeight: Math.min(height * 0.85, room),
            ...(full ? { height: Math.min(height * 0.85, room) } : {}),
            backgroundColor: t.bg,
            borderColor: t.border,
            paddingBottom: keyboard ? 12 : Math.max(insets.bottom, 12),
            transform: [{ translateY }],
          },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: t.border }]} />
        {content}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, marginBottom: 8 },
});
