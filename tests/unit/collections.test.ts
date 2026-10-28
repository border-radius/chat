import { afterEach, describe, expect, it, vi } from "vitest";
import { type CollectionsService, createCollections } from "../../web/src/collections.ts";
import { type AppState, createStore, initialState, type Store } from "../../web/src/store.ts";
import { intercept, type SignedUp, signedUp, uniq } from "../support/api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("collections service (§31)", () => {
  let me: SignedUp;
  let store: Store<AppState>;
  let service: CollectionsService | undefined;
  afterEach(async () => {
    service?.stop();
    service = undefined;
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  const publicCollection = async (owner: SignedUp) =>
    owner.api.request<{ id: string }>("/api/collections/collections/records", {
      method: "POST",
      body: { owner: owner.user.id, name: `c-${uniq()}`, public: true },
    });
  const follow = (who: SignedUp, id: string) => who.api.request("/api/chat/subs", { method: "POST", body: { collection: id, on: true } });
  const followed = () => store.get().collections?.subs.map((c) => c.id) ?? [];

  it("follows a collection followed elsewhere, live", async () => {
    me = await signedUp("Me");
    const other = await signedUp("Other");
    const c = await publicCollection(other);
    store = createStore<AppState>({ ...initialState(), user: me.user });
    service = createCollections({ api: me.api, store });
    service.start();
    await vi.waitFor(() => expect(store.get().collections).not.toBeNull());
    await sleep(300); // subscribed
    await follow(me, c.id);
    await vi.waitFor(() => expect(followed()).toContain(c.id));
  });

  it("QA BUG-170: a follow between reading the list and the subscription being in still shows", async () => {
    me = await signedUp("Me");
    const other = await signedUp("Other");
    const c = await publicCollection(other);
    store = createStore<AppState>({ ...initialState(), user: me.user });
    let subscribed = false;
    intercept(
      me.api,
      "subscribeCollections",
      (original) => (ids, fn) =>
        sleep(1500).then(async () => {
          const off = await original(ids, fn);
          subscribed = true;
          return off;
        }),
    );
    service = createCollections({ api: me.api, store });
    service.start();
    await vi.waitFor(() => expect(store.get().collections).not.toBeNull());
    await follow(me, c.id); // from another device: the list is read, the subscription not in yet
    expect(subscribed).toBe(false);
    await vi.waitFor(() => expect(followed()).toContain(c.id), { timeout: 5000 });
  });
});
