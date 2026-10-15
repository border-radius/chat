// Servers: the chat servers this app knows, and a field to add one by its address. There is no directory of servers:
// whoever invited you gives you the address. Each server keeps its own login; tapping one makes it the current one.

import { Image } from "expo-image";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { displayUrl, isInsecure, normalizeUrl, probe, type Server } from "../core/servers";
import { Button, ErrorText, Header, IconButton, Input, MenuSheet, styles } from "../ui/components";
import { useServers } from "../ui/context";
import { useTheme } from "../ui/theme";

export default function Servers() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { servers, session, connect, remove } = useServers();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<Server | null>(null);
  const ac = useRef<AbortController | null>(null);

  /** Check the server is there (and is a chat server), then make it current and go to its rooms. */
  async function open(input: string) {
    let url: string;
    try {
      url = normalizeUrl(input);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    ac.current?.abort();
    const ctl = new AbortController();
    ac.current = ctl;
    setBusy(url);
    setError("");
    try {
      const site = await probe(url, ctl.signal);
      if (ctl.signal.aborted) return;
      await connect(url, site);
      setAddress("");
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (e) {
      if (!ctl.signal.aborted) setError((e as Error).message);
    } finally {
      if (ac.current === ctl) setBusy(null);
    }
  }

  const empty = servers.length === 0;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="padding">
      <Header
        left={session ? <IconButton icon="←" label="Back" onPress={() => router.back()} /> : undefined}
        title={empty ? "Welcome" : "Servers"}
      />
      <FlatList
        data={servers}
        keyExtractor={(s) => s.url}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}
        ListHeaderComponent={
          <View style={{ marginBottom: 16 }}>
            {empty ? (
              <Text style={{ color: t.fg, fontSize: 16, lineHeight: 23, marginBottom: 16 }}>
                Chat runs on servers that anyone can host. Type the address of yours — whoever invited you can tell you what it is.
              </Text>
            ) : null}
            <Text style={[styles.label, { color: t.fg }]}>Add a server</Text>
            <View style={[styles.row, { gap: 8 }]}>
              <Input
                style={{ flex: 1 }}
                value={address}
                onChangeText={(v) => {
                  setAddress(v);
                  setError("");
                }}
                placeholder="chat.example.com"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                inputMode="url"
                returnKeyType="go"
                accessibilityLabel="Server address"
                onSubmitEditing={() => void open(address)}
                invalid={!!error}
              />
              <Button label="Connect" kind="primary" busy={!!busy && busy === safeNormalize(address)} onPress={() => void open(address)} />
            </View>
            <ErrorText>{error}</ErrorText>
            {!empty ? <Text style={[styles.label, { color: t.fg, marginTop: 24, marginBottom: 0 }]}>Your servers</Text> : null}
          </View>
        }
        renderItem={({ item }) => {
          const current = session?.server === item.url;
          return (
            <View style={[styles.row, { marginBottom: 8, gap: 4 }]}>
              <Pressable
                onPress={() => (current ? router.back() : void open(item.url))}
                onLongPress={() => setMenu(item)}
                accessibilityRole="button"
                accessibilityLabel={`${item.title}, ${displayUrl(item.url)}${isInsecure(item.url) ? ", not secure" : ""}${current ? ", current" : ""}`}
                accessibilityState={{ selected: current, busy: busy === item.url }}
                accessibilityHint="Long press for more"
                style={({ pressed }) => [
                  styles.row,
                  {
                    flex: 1,
                    gap: 12,
                    padding: 12,
                    borderRadius: 14,
                    backgroundColor: current ? t.tint : pressed ? t.hover : t.raised,
                    borderWidth: 1,
                    borderColor: current ? t.accent : t.border,
                  },
                ]}
              >
                {item.logo ? (
                  <Image source={{ uri: item.logo }} style={{ width: 40, height: 40, borderRadius: 10 }} contentFit="cover" />
                ) : (
                  <View style={[styles.center, { width: 40, height: 40, borderRadius: 10, backgroundColor: t.accent }]}>
                    <Text style={{ color: t.onAccent, fontWeight: "800", fontSize: 18 }}>{item.title.slice(0, 1).toUpperCase()}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.fg, fontWeight: "700", fontSize: 16 }} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={{ color: isInsecure(item.url) ? t.danger : t.muted, fontSize: 13 }} numberOfLines={1}>
                    {displayUrl(item.url)}
                    {isInsecure(item.url) ? " · not secure" : ""}
                  </Text>
                </View>
                {current ? <Text style={{ color: t.accent, fontWeight: "700" }}>Current</Text> : null}
              </Pressable>
              <IconButton icon="⋯" label={`More for ${item.title}`} onPress={() => setMenu(item)} size={36} />
            </View>
          );
        }}
      />
      <MenuSheet
        visible={!!menu}
        onClose={() => setMenu(null)}
        title={menu ? `${menu.title} · ${displayUrl(menu.url)}` : undefined}
        items={
          menu
            ? [
                { label: "Open", run: () => void open(menu.url) },
                {
                  label: "Remove from this phone",
                  confirm: {
                    text: `Remove ${menu.title}? You'll be logged out of it on this phone, and what you were writing there is lost.`,
                    action: "Remove",
                  },
                  run: () => void remove(menu.url),
                },
              ]
            : []
        }
      />
    </KeyboardAvoidingView>
  );
}

function safeNormalize(s: string) {
  try {
    return normalizeUrl(s);
  } catch {
    return null;
  }
}
