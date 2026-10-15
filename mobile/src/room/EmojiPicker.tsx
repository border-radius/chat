// The emoji picker (web ui/emoji-picker.ts, §20.4): the same emoji, by category, with the recently used ones first.
// For the composer (insert) and for reactions (`chosen`: yours, marked; picking one again takes it back).

import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, useWindowDimensions, View } from "react-native";
import { CATEGORIES, recentEmoji, rememberEmoji } from "../shared";
import { Sheet } from "../ui/components";
import { useTheme } from "../ui/theme";

const RECENT = "Recent";

export function EmojiPicker({
  visible,
  title,
  chosen,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  chosen?: ReadonlySet<string>;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const recent = useMemo(() => (visible ? recentEmoji() : []), [visible]);
  const tabs = useMemo(() => [...(recent.length ? [{ name: RECENT, icon: "🕘", emoji: recent }] : []), ...CATEGORIES], [recent]);
  const [tab, setTab] = useState<string | null>(null);
  const current = tabs.find((c) => c.name === tab) ?? tabs[0]!;
  const columns = Math.max(6, Math.floor((width - 16) / 48));
  const size = (width - 16) / columns;

  return (
    <Sheet visible={visible} onClose={onClose} full>
      <Text style={{ color: t.muted, fontWeight: "700", paddingHorizontal: 16, paddingBottom: 6 }}>{title}</Text>
      <View
        style={{ flexDirection: "row", paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: t.border }}
        accessibilityRole="tablist"
      >
        {tabs.map((c) => (
          <Pressable
            key={c.name}
            onPress={() => setTab(c.name)}
            accessibilityRole="tab"
            accessibilityLabel={c.name}
            accessibilityState={{ selected: c.name === current.name }}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 8,
              borderBottomWidth: 2,
              borderBottomColor: c.name === current.name ? t.accent : "transparent",
            }}
          >
            <Text style={{ fontSize: 20 }}>{c.icon}</Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        key={`${current.name}-${columns}`}
        data={current.emoji as string[]}
        numColumns={columns}
        keyExtractor={(e) => e}
        contentContainerStyle={{ padding: 8 }}
        renderItem={({ item }) => {
          const mine = chosen?.has(item);
          return (
            <Pressable
              onPress={() => {
                rememberEmoji(item);
                onPick(item);
                onClose();
              }}
              accessibilityRole="button"
              accessibilityLabel={item}
              accessibilityState={{ selected: !!mine }}
              style={({ pressed }) => ({
                width: size,
                height: size,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                backgroundColor: mine ? t.tint : pressed ? t.hover : "transparent",
              })}
            >
              <Text style={{ fontSize: Math.min(30, size * 0.6) }}>{item}</Text>
            </Pressable>
          );
        }}
      />
    </Sheet>
  );
}
