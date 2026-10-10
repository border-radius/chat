// Login / signup screen (§7.1).

import { type Api, ApiError, errorMessage } from "../api.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { LIMITS } from "../lib/limits.ts";
import type { User } from "../lib/types.ts";
import type { View } from "../router.ts";

type Mode = "login" | "signup";
type Field = "name" | "email" | "password";

interface FieldSpec {
  name: Field;
  label: string;
  type: string;
  autocomplete: string;
  extra?: Record<string, string | number>;
}

const FIELDS: Record<Mode, FieldSpec[]> = {
  login: [
    { name: "email", label: "Email", type: "email", autocomplete: "email" },
    { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
  ],
  signup: [
    { name: "name", label: "Display name", type: "text", autocomplete: "nickname", extra: { maxlength: LIMITS.userName } },
    { name: "email", label: "Email", type: "email", autocomplete: "email" },
    { name: "password", label: "Password", type: "password", autocomplete: "new-password", extra: { minlength: LIMITS.passwordMin } },
  ],
};

const TITLES: Record<Mode, string> = { login: "Log in", signup: "Sign up" };

export function createLoginView(deps: { api: Api; onLogin: (user: User) => void }): View {
  let ac: AbortController | null = null;
  let mode: Mode = "login";
  let busy = false;
  const values: Record<Field, string> = { name: "", email: "", password: "" };
  const prefix = uniqueId("login");
  let root: HTMLElement;

  function render(errors: { form?: string; fields?: Record<string, string> } = {}) {
    ac?.abort();
    ac = new AbortController();
    const { signal } = ac;

    const tabs = (Object.keys(TITLES) as Mode[]).map((m) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": String(m === mode),
          on: {
            click: () => {
              if (m === mode) return;
              mode = m;
              render();
            },
          },
          signal,
        },
        TITLES[m],
      ),
    );

    const submit = h("button", { type: "submit", class: "primary", disabled: busy }, TITLES[mode]);

    const fields = FIELDS[mode].map((f) => {
      const id = `${prefix}-${f.name}`;
      const errId = `${id}-error`;
      const error = errors.fields?.[f.name];
      return h("div", { class: "field" }, [
        h("label", { for: id }, f.label),
        h("input", {
          id,
          name: f.name,
          type: f.type,
          autocomplete: f.autocomplete,
          required: true,
          value: values[f.name],
          "aria-invalid": error ? "true" : null,
          "aria-describedby": errId,
          ...f.extra,
          on: { input: (e) => (values[f.name] = (e.target as HTMLInputElement).value) },
          signal,
        }),
        h("p", { id: errId, class: "field-error" }, error ?? ""),
      ]);
    });

    const form = h(
      "form",
      {
        class: "auth-form",
        "aria-label": TITLES[mode],
        on: {
          submit: (e) => {
            e.preventDefault();
            // Read the inputs now: autofill/password managers may not fire input events.
            for (const f of FIELDS[mode]) values[f.name] = (form.elements.namedItem(f.name) as HTMLInputElement).value;
            void onSubmit(submit);
          },
        },
        signal,
      },
      [...fields, h("p", { role: "alert", class: "form-error" }, errors.form ?? ""), submit],
    );

    clear(root);
    root.append(h("section", { class: "auth" }, [h("h1", {}, "Chat"), h("div", { role: "tablist", class: "tabs" }, tabs), form]));
  }

  async function onSubmit(button: HTMLButtonElement) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      const user =
        mode === "login"
          ? await deps.api.logIn(values.email, values.password)
          : await deps.api.signUp({ name: values.name, email: values.email, password: values.password });
      busy = false;
      button.disabled = false;
      deps.onLogin(user);
    } catch (e) {
      busy = false;
      if (!ac || ac.signal.aborted) return; // unmounted meanwhile
      // Errors for fields on screen go next to them; anything else (network, rate limit, …) above the button.
      const all = e instanceof ApiError ? e.fields : {};
      const fields = Object.fromEntries(Object.entries(all).filter(([k]) => FIELDS[mode].some((f) => f.name === k)));
      render({ form: Object.keys(fields).length ? "" : errorMessage(e), fields });
    }
  }

  return {
    mount(el) {
      root = el;
      render();
    },
    unmount() {
      ac?.abort();
      ac = null;
      clear(root);
    },
  };
}
