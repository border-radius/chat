import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../web/src/api.ts";
import type { View } from "../../../web/src/router.ts";
import { type AppState, createStore, initialState, type Store } from "../../../web/src/store.ts";
import { avatarProblem, createProfileView } from "../../../web/src/views/profile.ts";
import { instrument, type SignedUp, signedUp, viewContext } from "../../support/api.ts";
import { pngFile } from "../../support/files.ts";

describe("avatarProblem (§15.5)", () => {
  it("accepts the server's raster types up to 2 MB", () => {
    expect(avatarProblem(pngFile())).toBe("");
    expect(avatarProblem(new File(["x"], "a.svg", { type: "image/svg+xml" }))).toMatch(/JPEG, PNG/);
    expect(avatarProblem(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "a.png", { type: "image/png" }))).toMatch(/too large/);
  });
});

describe("profile view (§15.5)", () => {
  let root: HTMLElement;
  let me: SignedUp;
  let store: Store<AppState>;
  let view: View | undefined;

  beforeEach(async () => {
    root = document.createElement("main");
    document.body.append(root);
    me = await signedUp("Ada Lovelace");
    store = createStore<AppState>({ ...initialState(), user: me.user });
  });
  afterEach(async () => {
    view?.unmount();
    view = undefined;
    root.remove();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  function mount() {
    view = createProfileView(viewContext(me.api, store, vi.fn()));
    view.mount(root, {});
  }

  const picture = () => root.querySelector(".profile-picture .avatar")!;
  const fileInput = () => root.querySelector<HTMLInputElement>("input[type=file]")!;
  const removeButton = () => [...root.querySelectorAll("button")].find((b) => b.textContent === "Remove")!;
  const avatarError = () => root.querySelector(".profile-avatar ~ .field-error")!.textContent;
  const nameInput = () => root.querySelector<HTMLInputElement>("form.profile-name input")!;
  const status = () => root.querySelector(".field-status")!;

  function choose(file: File) {
    Object.defineProperty(fileInput(), "files", { configurable: true, value: [file] });
    fileInput().dispatchEvent(new Event("change"));
  }

  it("shows initials without an avatar, and no Remove", () => {
    mount();
    expect(picture().textContent).toBe("AL");
    expect(removeButton().hidden).toBe(true);
    expect(nameInput().value).toBe("Ada Lovelace");
  });

  it("choosing a picture previews it at once, uploads it, and updates the logged-in user", async () => {
    const ctl = instrument(me.api);
    const release = ctl.hold("setAvatar");
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      created.push(`blob:preview-${created.length}`);
      return created.at(-1)!;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
    mount();
    choose(pngFile("me.png"));
    await vi.waitFor(() => expect(picture().getAttribute("src")).toBe("blob:preview-0"));
    release();
    await vi.waitFor(() => expect(store.get().user?.avatar).toMatch(/\.png$/));
    expect(picture().getAttribute("src")).toContain("thumb=96x96");
    expect(revoked).toEqual(["blob:preview-0"]);
    expect(removeButton().hidden).toBe(false);
  });

  it("a failed upload restores the previous picture and says why", async () => {
    const ctl = instrument(me.api);
    ctl.failNext("setAvatar", new ApiError("Failed", 400, { avatar: "Invalid file." }));
    mount();
    choose(pngFile());
    await vi.waitFor(() => expect(avatarError()).toBe("Invalid file."));
    expect(picture().textContent).toBe("AL");
    expect(store.get().user?.avatar ?? "").toBe("");
  });

  it("refuses a non-image without uploading", async () => {
    const ctl = instrument(me.api);
    mount();
    choose(new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(avatarError()).toMatch(/JPEG, PNG/));
    expect(ctl.calls("setAvatar")).toBe(0);
  });

  it("Remove clears the avatar", async () => {
    store.set({ user: await me.api.setAvatar(pngFile()) });
    mount();
    expect(picture().tagName).toBe("IMG");
    removeButton().click();
    await vi.waitFor(() => expect(store.get().user?.avatar).toBe(""));
    expect(picture().textContent).toBe("AL");
  });

  it("saves a new display name; blank and over-long names are refused locally", async () => {
    const ctl = instrument(me.api);
    mount();
    const submit = () => root.querySelector("form.profile-name")!.dispatchEvent(new Event("submit", { cancelable: true }));
    nameInput().value = "   ";
    submit();
    expect(status().textContent).toMatch(/can't be empty/);
    nameInput().value = "x".repeat(33);
    submit();
    expect(status().textContent).toMatch(/no more than 32/);
    expect(ctl.calls("rename")).toBe(0);

    nameInput().value = " Ada King ";
    submit();
    await vi.waitFor(() => expect(store.get().user?.name).toBe("Ada King"));
    expect(status().textContent).toBe("Saved.");
    expect(nameInput().getAttribute("aria-invalid")).toBeNull();
  });
});
