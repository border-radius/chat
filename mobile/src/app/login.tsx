// Log in / Sign up (web views/login.ts, §7.1): the server's title and logo, an invite code while it is invite-only
// (§24), and the same error wording. Logged in, back to where you were.

import { Image } from "expo-image";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { displayUrl } from "../core/servers";
import { ApiError, errorMessage, LIMITS, SIGNUP_LOGIN_FAILED, textLength } from "../shared";
import { Button, ErrorText, Field, Header, IconButton, styles } from "../ui/components";
import { useAppState, useServers } from "../ui/context";
import { useTheme } from "../ui/theme";

type Mode = "login" | "signup";
type FieldName = "name" | "email" | "password" | "invite_code";

export default function Login() {
  const { session } = useServers();
  if (!session) return <Redirect href="/servers" />;
  return <LoginForm />;
}

function LoginForm() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ mode?: string; expired?: string }>();
  const session = useServers().session!;
  const site = useAppState((s) => s.site);
  const user = useAppState((s) => s.user);
  const [mode, setMode] = useState<Mode>(params.mode === "signup" ? "signup" : "login");
  const [values, setValues] = useState<Record<FieldName, string>>({ name: "", email: "", password: "", invite_code: "" });
  const [errors, setErrors] = useState<{ form?: string; fields?: Partial<Record<FieldName, string>> }>(
    params.expired ? { form: "Your session ended. Log in again to continue." } : {},
  );
  const [busy, setBusy] = useState(false);

  const fields: FieldName[] =
    mode === "login" ? ["email", "password"] : ["name", "email", "password", ...(site.inviteOnly ? (["invite_code"] as const) : [])];

  const leave = () => (router.canGoBack() ? router.back() : router.replace("/"));

  // Logged in (here, or the session came back another way): this page has nothing more to do.
  // biome-ignore lint/correctness/useExhaustiveDependencies: leave() only goes back
  useEffect(() => {
    if (user && !busy) leave();
  }, [user, busy]);

  const set = (k: FieldName) => (v: string) => setValues((s) => ({ ...s, [k]: v }));

  async function submit() {
    if (busy) return;
    if (mode === "signup" && textLength(values.name.trim()) > LIMITS.userName) {
      setErrors({ fields: { name: `Must be no more than ${LIMITS.userName} characters.` } });
      return;
    }
    const missing = fields.find((f) => !values[f].trim());
    if (missing) {
      setErrors({ fields: { [missing]: "Fill this in." } });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      if (mode === "login") await session.api.logIn(values.email.trim(), values.password);
      else
        await session.api.signUp({
          name: values.name,
          email: values.email.trim(),
          password: values.password,
          ...(site.inviteOnly ? { inviteCode: values.invite_code } : {}),
        });
      setBusy(false); // logged in: the effect above leaves the page
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.codes.auth === SIGNUP_LOGIN_FAILED) {
        setMode("login");
        setErrors({ form: `Your account was created, but logging in failed: ${errorMessage(e)} Log in to continue.` });
        return;
      }
      const all = e instanceof ApiError ? e.fields : {};
      const shown = Object.fromEntries(Object.entries(all).filter(([k]) => (fields as string[]).includes(k))) as Partial<
        Record<FieldName, string>
      >;
      if (mode === "signup" && e instanceof ApiError && e.codes.email === "validation_not_unique") {
        shown.email = "There is already an account with this email. Log in instead.";
      }
      const badLogin = mode === "login" && e instanceof ApiError && e.status === 400;
      const invite = e instanceof ApiError && !shown.invite_code ? all.invite_code : undefined;
      const form = Object.keys(shown).length ? "" : (invite ?? (badLogin ? "Wrong email or password." : errorMessage(e)));
      setErrors({ form, fields: shown });
    }
  }

  const spec: Record<FieldName, { label: string; props: object }> = {
    name: { label: "Display name", props: { autoComplete: "nickname", textContentType: "nickname" } },
    email: {
      label: "Email",
      props: {
        autoComplete: "email",
        keyboardType: "email-address",
        autoCapitalize: "none",
        autoCorrect: false,
        textContentType: "emailAddress",
      },
    },
    password: {
      label: "Password",
      props: {
        secureTextEntry: true,
        autoComplete: mode === "login" ? "current-password" : "new-password",
        textContentType: mode === "login" ? "password" : "newPassword",
        autoCapitalize: "none",
      },
    },
    invite_code: { label: "Invite code", props: { autoCapitalize: "none", autoCorrect: false } },
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="padding">
      <Header left={<IconButton icon="←" label="Back" onPress={leave} />} title="" />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24 }}>
        <View style={[styles.row, { gap: 10, marginBottom: 4 }]}>
          {site.logo ? <Image source={{ uri: site.logo }} style={{ width: 40, height: 40, borderRadius: 10 }} contentFit="cover" /> : null}
          <Text accessibilityRole="header" style={{ color: t.fg, fontSize: 28, fontWeight: "800", flexShrink: 1 }}>
            {site.title}
          </Text>
        </View>
        <Text style={{ color: t.muted, marginBottom: 20 }}>{displayUrl(session.server)}</Text>
        <View
          style={[styles.row, { backgroundColor: t.surface, borderRadius: 999, padding: 4, marginBottom: 20 }]}
          accessibilityRole="tablist"
        >
          {(["login", "signup"] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === m }}
              onPress={() => {
                setMode(m);
                setErrors({});
              }}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: 999,
                alignItems: "center",
                backgroundColor: mode === m ? t.raised : "transparent",
              }}
            >
              <Text style={{ color: mode === m ? t.fg : t.muted, fontWeight: "700" }}>{m === "login" ? "Log in" : "Sign up"}</Text>
            </Pressable>
          ))}
        </View>
        {fields.map((f, i) => (
          <Field
            key={`${mode}-${f}`}
            label={spec[f].label}
            value={values[f]}
            onChangeText={set(f)}
            error={errors.fields?.[f]}
            returnKeyType={i === fields.length - 1 ? "go" : "next"}
            onSubmitEditing={i === fields.length - 1 ? () => void submit() : undefined}
            hint={f === "password" && mode === "signup" ? `At least ${LIMITS.passwordMin} characters.` : undefined}
            {...spec[f].props}
          />
        ))}
        <ErrorText style={{ marginBottom: 12 }}>{errors.form}</ErrorText>
        <Button label={mode === "login" ? "Log in" : "Sign up"} kind="primary" busy={busy} onPress={() => void submit()} />
        <Button label="Just looking? Read the Open Air rooms" kind="link" onPress={leave} style={{ marginTop: 16 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
