// Profile (web views/profile.ts, §15.5, §22.2): your picture, display name (unique), password, the server you are
// on, and logging out.

import { Redirect, router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeFile } from "../core/client";
import { pickAvatar } from "../core/files";
import { displayUrl } from "../core/servers";
import { ApiError, errorMessage, LIMITS, passwordProblem, textLength, type User } from "../shared";
import { Avatar, Button, ErrorText, Field, Header, IconButton, styles } from "../ui/components";
import { useAppState, useServers, useSession } from "../ui/context";
import { useTheme } from "../ui/theme";

export default function Me() {
  const { session } = useServers();
  const user = useServers().session?.store.get().user;
  if (!session || !user) return <Redirect href="/" />;
  return <Profile />;
}

const fieldMessage = (e: unknown, field: string) => (e instanceof ApiError && e.fields[field]) || errorMessage(e);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: 28 }}>
      <Text accessibilityRole="header" style={{ color: t.fg, fontSize: 18, fontWeight: "800", marginBottom: 12 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Profile() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const { api, store } = session;
  const user = useAppState((s) => s.user);
  const site = useAppState((s) => s.site);

  const [busy, setBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [name, setName] = useState(user?.name ?? "");
  const [nameStatus, setNameStatus] = useState<{ text: string; error: boolean }>({ text: "", error: false });
  const [savingName, setSavingName] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwErrors, setPwErrors] = useState<Partial<Record<"current" | "next" | "confirm", string>>>({});
  const [pwStatus, setPwStatus] = useState<{ text: string; error: boolean }>({ text: "", error: false });
  const [savingPw, setSavingPw] = useState(false);

  if (!user) return <Redirect href="/" />;

  async function save(call: () => Promise<User>) {
    setBusy(true);
    setAvatarError("");
    try {
      store.set({ user: await call() });
    } catch (e) {
      setAvatarError(fieldMessage(e, "avatar"));
    } finally {
      setBusy(false);
    }
  }

  async function changePicture() {
    let file: NativeFile | null;
    try {
      file = await pickAvatar();
    } catch (e) {
      setAvatarError((e as Error).message);
      return;
    }
    if (!file) return;
    if (!(LIMITS.avatarTypes as readonly string[]).includes(file.type)) return setAvatarError("Choose a JPEG, PNG, WebP or GIF image.");
    if (file.size > LIMITS.avatarBytes) return setAvatarError(`That image is too large (max ${LIMITS.avatarBytes / 1024 / 1024} MB).`);
    await save(() => api.setAvatar(file as unknown as File));
  }

  async function rename() {
    const n = name.trim();
    const problem = !n
      ? "A display name can't be empty."
      : textLength(n) > LIMITS.userName
        ? `Must be no more than ${LIMITS.userName} characters.`
        : "";
    if (problem) return setNameStatus({ text: problem, error: true });
    setNameStatus({ text: "", error: false });
    if (n === user?.name) return;
    setSavingName(true);
    try {
      const u = await api.rename(n);
      store.set({ user: u });
      setName(u.name);
      setNameStatus({ text: "Saved.", error: false });
    } catch (e) {
      setNameStatus({ text: fieldMessage(e, "name"), error: true });
    } finally {
      setSavingName(false);
    }
  }

  async function changePassword() {
    setPwStatus({ text: "", error: false });
    const problem = passwordProblem(pw.current, pw.next, pw.confirm);
    setPwErrors(problem);
    if (Object.keys(problem).length) return;
    setSavingPw(true);
    try {
      store.set({ user: await api.changePassword(pw.current, pw.next) });
      setPw({ current: "", next: "", confirm: "" });
      setPwStatus({ text: "Password changed. You were logged out everywhere else.", error: false });
    } catch (e) {
      const fields = e instanceof ApiError ? e.fields : {};
      if (fields.oldPassword || fields.password) {
        setPwErrors({
          ...(fields.oldPassword ? { current: fields.oldPassword } : {}),
          ...(fields.password ? { next: fields.password } : {}),
        });
      } else setPwStatus({ text: errorMessage(e), error: true });
    } finally {
      setSavingPw(false);
    }
  }

  const pwField = (key: "current" | "next" | "confirm", label: string) => (
    <Field
      label={label}
      value={pw[key]}
      onChangeText={(v) => setPw((p) => ({ ...p, [key]: v }))}
      error={pwErrors[key]}
      secureTextEntry
      autoCapitalize="none"
      autoComplete={key === "current" ? "current-password" : "new-password"}
      textContentType={key === "current" ? "password" : "newPassword"}
    />
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="padding">
      <Header left={<IconButton icon="←" label="Back to rooms" onPress={() => router.back()} />} title="Your profile" />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24 }}>
        <Section title="Picture">
          <View style={[styles.row, { gap: 16 }]}>
            <View style={{ borderRadius: 60, borderWidth: 3, borderColor: t.accent, padding: 3 }}>
              <Avatar user={user} size={96} url={api.avatarUrl} />
              {busy ? <ActivityIndicator style={{ position: "absolute", top: 40, left: 40 }} color={t.accent} /> : null}
            </View>
            <View style={{ gap: 8 }}>
              <Button label="Change picture" onPress={() => void changePicture()} disabled={busy} />
              {user.avatar && !busy ? <Button label="Remove" onPress={() => void save(() => api.removeAvatar())} /> : null}
            </View>
          </View>
          <ErrorText>{avatarError}</ErrorText>
        </Section>

        <Section title="Display name">
          <Field
            label="Display name"
            value={name}
            onChangeText={(v) => {
              setName(v);
              setNameStatus({ text: "", error: false });
            }}
            error={nameStatus.error ? nameStatus.text : undefined}
            hint={!nameStatus.error ? nameStatus.text : undefined}
            autoComplete="nickname"
            returnKeyType="done"
            onSubmitEditing={() => void rename()}
          />
          <Button label="Save" kind="primary" busy={savingName} onPress={() => void rename()} />
        </Section>

        <Section title="Password">
          {pwField("current", "Current password")}
          {pwField("next", "New password")}
          {pwField("confirm", "Confirm new password")}
          <Button label="Change password" kind="primary" busy={savingPw} onPress={() => void changePassword()} />
          {pwStatus.text ? <Text style={{ color: pwStatus.error ? t.danger : t.muted, marginTop: 8 }}>{pwStatus.text}</Text> : null}
        </Section>

        <Section title="Session">
          <Text style={{ color: t.muted, marginBottom: 12 }}>
            Logged in to {site.title} ({displayUrl(session.server)}) as {user.name}.
          </Text>
          <View style={{ gap: 10 }}>
            <Button label="Switch server" onPress={() => router.push("/servers")} />
            <Button
              label="Log out"
              kind="danger"
              onPress={() => {
                session.logOut();
                router.dismissTo("/");
              }}
            />
          </View>
        </Section>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
