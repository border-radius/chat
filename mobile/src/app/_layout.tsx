// Root: storage and the last server load first; then every screen, with the current server's session. The keyboard
// is tracked for the whole app (Android draws edge-to-edge: nothing resizes for it by itself), and sheets are drawn
// over everything (ui/sheets.tsx).

import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ServersProvider, useServers } from "../ui/context";
import { SheetHost } from "../ui/sheets";
import { useTheme } from "../ui/theme";

function Screens() {
  const { ready, session } = useServers();
  const t = useTheme();
  // The session ran out or was revoked (a password change elsewhere signs out every other device): log in again,
  // and back to where you were (§22.2).
  useEffect(() => session?.onExpired(() => router.push({ pathname: "/login", params: { expired: "1" } })), [session]);
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }
  return (
    <SheetHost>
      <StatusBar style={t.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.bg },
          // The same slide in, at Android's short duration (~200 ms) rather than the medium one (~400 ms).
          animation: "ios_from_right",
        }}
      />
    </SheetHost>
  );
}

export default function Layout() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <ServersProvider>
          <Screens />
        </ServersProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
