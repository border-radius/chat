// Media collections (§31), what most visits never use: a collection's page (/c/:id: its items as a grid like the media
// grid's, newest first under month headings, what is new since you last looked highlighted), the save menu (which of
// your collections have a file; tick to add, untick to take out, or make a new one), the picker the composer opens
// (items of your collections and those you follow, to attach), and the new-collection dialog. Their requests are here
// too (`calls`, through Api.request), so app.js doesn't carry them.
//
// A lazy chunk, like the media grid (§30.2): views/collection.ts import()s it, and it links its own stylesheet
// (styles/collections.css). It imports types only; what it needs from app.js comes in its options. The viewer
// (§17.7) is another chunk, which it import()s itself.

import type { Api } from "../../api.ts";
import type { CollectionsService } from "../../collections.ts";
import type { h as H } from "../../dom.ts";
import type { Collection, CollectionItem, Collections, Message, User } from "../../lib/types.ts";
import type { ViewerImage } from "../room/viewer.ts";

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const COLLECTIONS_CSS: string;

interface Base {
  api: Api;
  h: typeof H;
  service: CollectionsService;
  me: () => User | null;
  /** Yours and those you follow, as the store has them. */
  list: () => Collections;
  /** Call `fn` when they change; returns the unsubscribe. */
  watch: (fn: () => void) => () => void;
  /** When an item was added, for the viewer. */
  when: (created: string) => string;
  signal: AbortSignal;
}

let stylesheet: Promise<void> | null = null;
function loadStylesheet(h: typeof H): Promise<void> {
  stylesheet ??= new Promise((resolve) => {
    const failed = () => {
      link.remove();
      stylesheet = null;
      resolve();
    };
    const link = h("link", { rel: "stylesheet", href: COLLECTIONS_CSS, on: { load: () => resolve(), error: failed } });
    document.head.append(link);
  });
  return stylesheet;
}

/** What a collection's page shows of it. */
interface Meta {
  id: string;
  name: string;
  public: boolean;
  owner: string;
  items: number;
}

/** A message's file (the one that has it: a forward's original, §21.3), or an item. */
type From = { message: string; file: string } | { item: string };

/** A collection's page of items, as the media grid's (§30.2). */
const PAGE = 60;
const RECORDS = "/api/collections/collections/records";
/** A value in a records filter (ids and dates here), quoted and escaped. */
const lit = (v: string) => JSON.stringify(v);

/** The requests of the page, the menu and the picker. */
function calls(api: Api) {
  return {
    get: (id: string, signal: AbortSignal) =>
      api.request<Meta>(`${RECORDS}/${id}`, { query: { fields: "id,name,public,owner,items" }, signal }),
    create: (owner: string, name: string, isPublic: boolean) =>
      api.request<{ id: string }>(RECORDS, { method: "POST", body: { owner, name, public: isPublic }, query: { fields: "id" } }),
    update: (id: string, body: { name?: string; public?: boolean }) =>
      api.request(`${RECORDS}/${id}`, { method: "PATCH", body, query: { fields: "id" } }),
    remove: (id: string) => api.request(`${RECORDS}/${id}`, { method: "DELETE" }),
    /** A page of a collection's items, newest first, older than `after` (the oldest shown) or the newest. */
    async items(collection: string, after: CollectionItem | undefined, signal: AbortSignal) {
      const cursor = after ? ` && (created < ${lit(after.created)} || (created = ${lit(after.created)} && id < ${lit(after.id)}))` : "";
      const query = {
        filter: `collection = ${lit(collection)}${cursor}`,
        sort: "-created,-id",
        perPage: PAGE + 1,
        skipTotal: true,
        fields: "id,collection,file,name,video,poster,created",
      };
      const { items } = await api.request<{ items: CollectionItem[] }>("/api/collections/collection_items/records", { query, signal });
      return { items: items.slice(0, PAGE), more: items.length > PAGE };
    },
    /** A copy of a message's file or of an item in a collection of yours. 409: it is in there already. */
    save: (collection: string, from: From) =>
      api.request<CollectionItem>("/api/chat/items", { method: "POST", body: { collection, ...from } }),
    unsave: (item: string) => api.request(`/api/chat/items/${item}`, { method: "DELETE" }),
    /** Your collections that have the file already: collection id → item id. */
    savedIn: (from: From, signal: AbortSignal) => api.request<Record<string, string>>("/api/chat/saved", { query: from, signal }),
    follow: (collection: string, on: boolean) => api.request("/api/chat/subs", { method: "POST", body: { collection, on } }),
  };
}

/** The next change of the collections in the store, or `ms` without one. */
function changed(o: Base, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = o.watch(done);
    const timer = setTimeout(done, ms);
  });
}

const icon = (h: typeof H) => h("span", { class: "ci", "aria-hidden": "true" });
const monthOf = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dateOf = (created: string) => new Date(created.replace(" ", "T"));

/** An item as the viewer takes it: a message of its own with one file. */
function asMessage(it: CollectionItem): Message {
  const { id, created, file, name } = it;
  return {
    id,
    room: "",
    author: "",
    text: "",
    created,
    updated: created,
    edited_at: "",
    deleted: false,
    files: [file],
    file_names: { [file]: name },
  };
}

/** A square tile's picture: the grid thumbnail, a video's poster, or nothing (a plain tile with ▶). Retries once with a new token. */
function picture(b: Base, it: CollectionItem, signal: AbortSignal): HTMLImageElement | null {
  if (it.video && !it.poster) return null;
  const src = () => (it.video ? b.api.itemPosterUrl(it) : b.api.itemUrl(it, "240x240"));
  const img = b.h("img", { src: src(), alt: "", loading: "lazy", decoding: "async" });
  let retried = false;
  img.addEventListener(
    "error",
    () => {
      if (retried) return void (it.video && img.remove());
      retried = true;
      void b.api.fileToken(true).then(
        () => (img.src = src()),
        () => {},
      );
    },
    { signal },
  );
  return img;
}

/** A collection's items a page at a time, newest first. */
function pager(b: Base, collection: string, signal: AbortSignal) {
  const items: CollectionItem[] = [];
  let done = false;
  let loading: Promise<CollectionItem[]> | null = null;
  return {
    items,
    get done() {
      return done;
    },
    /** The next page (the same one while it loads); rejects when it fails. */
    next(): Promise<CollectionItem[]> {
      if (done) return Promise.resolve([]);
      loading ??= calls(b.api)
        .items(collection, items.at(-1), signal)
        .then(
          (page: { items: CollectionItem[]; more: boolean }) => {
            loading = null;
            done = !page.more;
            items.push(...page.items);
            return page.items;
          },
          (e: unknown) => {
            loading = null;
            throw e;
          },
        );
      return loading!;
    },
  };
}

// ---------------------------------------------------------------- the page

export interface PageOptions extends Base {
  id: string;
  navigate: (path: string) => void;
}

export async function mountCollection(root: HTMLElement, o: PageOptions): Promise<void> {
  const { h, api, signal, id } = o;
  const [, meta] = await Promise.all([
    loadStylesheet(h),
    calls(api)
      .get(id, signal)
      .catch(() => null),
    (async () => {
      // Your subscription's `seen_at` decides what is new: wait for the store to have it (just after a reload).
      if (o.me() && !o.list().mine.length && !o.list().subs.length) {
        await changed(o, 2000);
      }
    })(),
  ]);
  if (signal.aborted) return;
  const heading = h("h1", { id: "coll-title" }, [icon(h), " ", meta?.name ?? "This collection doesn't exist."]);
  if (!meta) {
    root.replaceChildren(
      h("section", { class: "collection not-found" }, [
        heading,
        h("p", {}, ["It may be private, or deleted. ", h("a", { href: "/" }, "Back to rooms")]),
      ]),
    );
    return;
  }
  let info = meta;
  const me = o.me();
  const mine = !!me && info.owner === me.id;
  const seenAt = o.list().subs.find((c) => c.id === id)?.seen_at ?? "";
  const pages = pager(o, id, signal);

  const metaLine = h("p", { class: "coll-meta" });
  const actions = h("div", { class: "coll-actions" });
  const notice = h("p", { class: "coll-notice", role: "status" });
  const newLine = h("p", { class: "coll-new", hidden: true });
  const grid = h("div", { class: "media-grid coll-grid" });
  const status = h("p", { class: "media-status", role: "status" });
  root.replaceChildren(
    h("section", { class: "collection", "aria-labelledby": "coll-title" }, [
      h("header", { class: "coll-head" }, [heading, metaLine, actions, notice]),
      newLine,
      grid,
      status,
    ]),
  );
  let ownerName = mine ? "you" : "";
  if (!mine) {
    void api
      .usersById([info.owner], signal)
      .then(([u]) => {
        ownerName = u?.name ?? "";
        renderHead();
      })
      .catch(() => {});
  }

  const fail = (what: string, e: unknown) => {
    notice.textContent = `Couldn't ${what}. ${e instanceof Error ? e.message : ""}`.trim();
  };
  const btn = (label: string, run: () => unknown, cls = "") =>
    h("button", { type: "button", class: cls, on: { click: () => void run() }, signal }, label);

  const call = calls(api);
  async function change(patch: { name?: string; public?: boolean }) {
    try {
      await call.update(id, patch);
      o.service.refresh();
      info = { ...info, ...patch };
      notice.textContent = "";
    } catch (e) {
      fail("save", e);
    }
    renderHead();
  }

  function renameForm() {
    const input = h("input", { value: info.name, "aria-label": "Collection name", autocomplete: "off" });
    const form = h(
      "form",
      {
        class: "coll-rename",
        on: {
          submit: (e) => {
            e.preventDefault();
            void change({ name: input.value });
          },
          keydown: (e) => e.key === "Escape" && renderHead(),
        },
        signal,
      },
      [input, h("button", { type: "submit" }, "Save"), btn("Cancel", renderHead, "link")],
    );
    actions.replaceChildren(form);
    input.focus();
    input.select();
  }

  function confirmDelete() {
    actions.replaceChildren(
      h("span", {}, `Delete “${info.name}” and its ${info.items} items? This can't be undone.`),
      btn(
        "Delete collection",
        async () => {
          try {
            await call.remove(id);
            o.service.refresh();
            o.navigate("/");
          } catch (e) {
            fail("delete it", e);
            renderHead();
          }
        },
        "danger",
      ),
      btn("Cancel", renderHead, "link"),
    );
  }

  function renderHead() {
    if (signal.aborted) return;
    heading.replaceChildren(icon(h), " ", info.name);
    const following = o.list().subs.some((c) => c.id === id);
    metaLine.replaceChildren(
      [
        ownerName && (mine ? "Yours" : `By ${ownerName}`),
        info.public ? "Public" : "🔒 Private",
        `${info.items} ${info.items === 1 ? "item" : "items"}`,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    if (mine) {
      actions.replaceChildren(
        btn("Rename", renameForm),
        btn(info.public ? "Make private" : "Make public", () => change({ public: !info.public })),
        btn("Delete", confirmDelete, "danger"),
      );
    } else if (me && info.public) {
      const b = btn(following ? "Unsubscribe" : "Subscribe", async () => {
        b.disabled = true;
        try {
          await call.follow(id, !following);
          o.service.refresh();
          await changed(o, 1000);
        } catch (e) {
          fail(following ? "unsubscribe" : "subscribe", e);
        }
        renderHead();
      });
      b.setAttribute("aria-pressed", String(following));
      actions.replaceChildren(b);
    } else actions.replaceChildren();
  }
  renderHead();
  signal.addEventListener("abort", o.watch(renderHead), { once: true });

  let month = "";
  let fresh = 0;
  function add(it: CollectionItem) {
    const mo = monthOf.format(dateOf(it.created));
    if (mo !== month) {
      month = mo;
      grid.append(h("h3", {}, mo));
    }
    const isNew = !!seenAt && it.created > seenAt;
    if (isNew) fresh++;
    const label = `${it.name}${it.video ? ", video" : ""}${isNew ? ", new" : ""}`;
    const tile = h(
      "button",
      {
        type: "button",
        class: "media-tile",
        "aria-label": label,
        title: it.name,
        on: { click: () => void open(it, tile) },
        signal,
      },
      [picture(o, it, signal), it.video && h("span", { "aria-hidden": "true" }, "▶")],
    );
    const cell = h("div", { class: `coll-cell${isNew ? " new" : ""}`, dataset: { item: it.id } }, [tile]);
    if (me) {
      const save: HTMLButtonElement = h(
        "button",
        {
          type: "button",
          class: "att-save",
          "aria-label": `Save ${it.name} to collection`,
          title: "Save to collection",
          on: { click: () => openSave({ ...o, from: { item: it.id }, opener: save }) },
          signal,
        },
        icon(h),
      );
      cell.append(save);
    }
    if (mine) {
      cell.append(
        h(
          "button",
          {
            type: "button",
            class: "coll-remove",
            "aria-label": `Remove ${it.name} from the collection`,
            title: "Remove from collection",
            on: {
              click: async () => {
                try {
                  await call.unsave(it.id);
                  cell.remove();
                  info = { ...info, items: Math.max(0, info.items - 1) };
                  renderHead();
                  o.service.refresh();
                } catch (e) {
                  fail("remove it", e);
                }
              },
            },
            signal,
          },
          "×",
        ),
      );
    }
    grid.append(cell);
  }

  async function more() {
    if (pages.done) return;
    status.textContent = "Loading…";
    try {
      const page = await pages.next();
      if (signal.aborted) return;
      for (const it of page) add(it);
      status.textContent =
        pages.done && !pages.items.length ? (mine ? "Nothing here yet. Save images and videos from the chat." : "Nothing here yet.") : "";
    } catch {
      if (signal.aborted) return;
      seen.unobserve(status);
      status.replaceChildren(
        "Couldn't load the collection. ",
        btn("Retry", () => void more(), "link"),
      );
      return;
    }
    seen.unobserve(status);
    if (!pages.done) seen.observe(status);
  }

  async function open(it: CollectionItem, opener: HTMLElement) {
    const images = (): ViewerImage[] => [...pages.items].reverse().map((x) => ({ message: asMessage(x), file: x.file, video: x.video }));
    const all = images();
    try {
      const { openViewer } = await import("../room/viewer.ts");
      if (signal.aborted) return;
      await openViewer({
        images: all,
        start: all.findIndex((x) => x.message.id === it.id),
        more: [!pages.done, false],
        page: async (older) => {
          const got = older ? await pages.next() : [];
          return { messages: got.map(asMessage).reverse(), done: !older || pages.done };
        },
        media: (m) => [{ message: m, file: m.files![0]!, video: pages.items.find((x) => x.id === m.id)?.video ?? false }],
        h,
        name: (m, f) => m.file_names?.[f] ?? f,
        when: (m) => o.when(m.created),
        fileUrl: (m, f) => api.itemUrl({ id: m.id, file: f }),
        refreshFileToken: () => api.fileToken(true),
        ...(me ? { onSave: (m: Message, _f: string, b: HTMLElement) => openSave({ ...o, from: { item: m.id }, opener: b }) } : {}),
        opener,
        follow: () => {},
        signal,
      });
    } catch {
      window.open(api.itemUrl(it), "_blank", "noopener");
    }
  }

  const seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), { rootMargin: "400px" });
  signal.addEventListener("abort", () => seen.disconnect(), { once: true });
  await more();
  if (signal.aborted) return;
  if (fresh) {
    newLine.hidden = false;
    newLine.textContent = `${fresh >= 60 ? "60+" : fresh} new since your last visit`;
  }
  // Seen once it is on screen in a visible tab: the sidebar's count goes.
  const newest = pages.items[0];
  if (newest && o.list().subs.some((c) => c.id === id)) {
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", mark);
      o.service.seen(id, newest.created);
    };
    document.addEventListener("visibilitychange", mark, { signal });
    mark();
  }
}

// ---------------------------------------------------------------- the save menu

export interface SaveOptions extends Base {
  from: From;
  /** Gets focus back on close. */
  opener: HTMLElement;
}

/** One save menu at a time. */
let saving: (() => void) | null = null;

export async function openSave(o: SaveOptions): Promise<void> {
  saving?.();
  const { h } = o;
  const call = calls(o.api);
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(), { signal });
  const title = h("h2", { id: "coll-save-title" }, [icon(h), " Save to collection"]);
  const list = h("ul", { class: "coll-choices" });
  const status = h("p", { class: "coll-status", role: "status" }, "Loading…");
  const input = h("input", { placeholder: "New collection", "aria-label": "New collection name", autocomplete: "off" });
  const form = h(
    "form",
    {
      class: "coll-new-form",
      on: {
        submit: async (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          try {
            const id = (await call.create(o.me()?.id ?? "", input.value, false)).id;
            input.value = "";
            await toggle(id, true);
          } catch (err) {
            status.textContent = reason(err);
          }
        },
      },
      signal,
    },
    [input, h("button", { type: "submit" }, "Create")],
  );
  const dialog = h("dialog", { class: "coll-dialog coll-save", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", { type: "button", class: "link", "aria-label": "Close", on: { click: () => close() }, signal }, "×"),
    ]),
    h("div", { class: "coll-body" }, [list, status, form]),
  ]);
  /** Collection id → the item there (ticked). */
  let saved: Record<string, string> = {};
  const busy = new Set<string>();

  const reason = (e: unknown) => {
    const err = e as { fields?: Record<string, string>; message?: string; status?: number };
    if (err?.status === 0) return "Can't reach the server. Check your connection.";
    return Object.values(err?.fields ?? {})[0] || err?.message || "Something went wrong.";
  };

  async function toggle(id: string, on: boolean) {
    busy.add(id);
    render();
    try {
      if (on) saved[id] = (await call.save(id, o.from)).id;
      else if (saved[id]) {
        await call.unsave(saved[id]);
        delete saved[id];
      }
      status.textContent = on ? "Saved." : "Removed.";
      o.service.refresh();
    } catch (e) {
      // In there already (another tab): it is ticked.
      if ((e as { status?: number }).status === 409) saved = await call.savedIn(o.from, signal).catch(() => saved);
      else status.textContent = reason(e);
    }
    busy.delete(id);
    render();
  }

  function render() {
    const mine = o.list().mine;
    list.replaceChildren(
      ...mine.map((c: Collection) => {
        const box = h("input", { type: "checkbox", checked: !!saved[c.id], disabled: busy.has(c.id) });
        box.addEventListener("change", () => void toggle(c.id, box.checked), { signal });
        return h(
          "li",
          {},
          h("label", {}, [box, " ", c.name, h("span", { class: "coll-meta" }, c.public ? " · Public: anyone can see it" : " 🔒")]),
        );
      }),
    );
    if (!mine.length && status.textContent === "") status.textContent = "You have no collections yet. Make one:";
  }

  function close() {
    if (signal.aborted) return;
    scope.abort();
    saving = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    o.opener.setAttribute("aria-expanded", "false");
    o.opener.focus();
  }
  saving = close;
  dialog.addEventListener("close", () => close(), { signal });
  signal.addEventListener("abort", o.watch(render), { once: true });

  await loadStylesheet(h);
  if (signal.aborted) return;
  document.body.append(dialog);
  dialog.showModal();
  o.opener.setAttribute("aria-expanded", "true");
  try {
    saved = await call.savedIn(o.from, signal);
    status.textContent = "";
  } catch (e) {
    if (signal.aborted) return;
    status.textContent = reason(e);
  }
  render();
  (list.querySelector("input") ?? input).focus();
}

// ---------------------------------------------------------------- the picker

export interface PickOptions extends Base {
  /** At most this many may be picked (what the message still has room for). */
  max: number;
  /** Attach these (Attach was pressed). */
  onPick: (items: CollectionItem[]) => void;
  opener: HTMLElement;
}

export async function openPicker(o: PickOptions): Promise<void> {
  const { h } = o;
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(), { signal });
  const { mine, subs } = o.list();
  const all = [...mine, ...subs];
  const title = h("h2", { id: "coll-pick-title" }, [icon(h), " Attach from collections"]);
  const select = h(
    "select",
    { "aria-label": "Collection" },
    all.map((c) => h("option", { value: c.id }, c.owner ? `${c.name} · ${c.owner.name}` : c.name)),
  );
  const grid = h("div", { class: "media-grid coll-grid" });
  const status = h("p", { class: "media-status", role: "status" });
  const count = h("span", { class: "coll-count", "aria-live": "polite" });
  const attach = h("button", { type: "button", disabled: true, on: { click: () => done() }, signal }, "Attach");
  const body = h("div", { class: "coll-body" }, [grid, status]);
  const dialog = h("dialog", { class: "coll-dialog coll-pick", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", { type: "button", class: "link", "aria-label": "Close", on: { click: () => close() }, signal }, "×"),
    ]),
    all.length ? select : null,
    body,
    h("footer", { class: "coll-foot" }, [count, attach]),
  ]);
  /** Picked, in the order they were. */
  const picked = new Map<string, CollectionItem>();
  let pages = pager(o, "", signal);

  function update() {
    count.textContent = picked.size ? `${picked.size} picked${picked.size >= o.max ? " (the most a message takes)" : ""}` : "";
    attach.disabled = !picked.size;
    attach.textContent = picked.size ? `Attach ${picked.size}` : "Attach";
  }

  function tile(it: CollectionItem) {
    const b: HTMLButtonElement = h(
      "button",
      {
        type: "button",
        class: "media-tile",
        "aria-label": `${it.name}${it.video ? ", video" : ""}`,
        title: it.name,
        "aria-pressed": String(picked.has(it.id)),
        on: {
          click: () => {
            if (picked.has(it.id)) picked.delete(it.id);
            else if (picked.size < o.max) picked.set(it.id, it);
            b.setAttribute("aria-pressed", String(picked.has(it.id)));
            update();
          },
        },
        signal,
      },
      [picture(o, it, signal), it.video && h("span", { "aria-hidden": "true" }, "▶")],
    );
    return b;
  }

  async function more() {
    if (pages.done || !select.value) return;
    const p = pages;
    status.textContent = "Loading…";
    try {
      const got = await p.next();
      if (signal.aborted || p !== pages) return;
      grid.append(...got.map(tile));
      status.textContent = p.done && !p.items.length ? "Nothing in this collection yet." : "";
    } catch {
      if (signal.aborted || p !== pages) return;
      seen.unobserve(status);
      status.replaceChildren(
        "Couldn't load the collection. ",
        h("button", { type: "button", class: "link", on: { click: () => void more() }, signal }, "Retry"),
      );
      return;
    }
    seen.unobserve(status);
    if (!p.done) seen.observe(status);
  }

  function show() {
    pages = pager(o, select.value, signal);
    grid.replaceChildren();
    void more();
  }
  select.addEventListener("change", show, { signal });
  const seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), { root: body, rootMargin: "400px" });

  function done() {
    const items = [...picked.values()];
    close();
    if (items.length) o.onPick(items);
  }

  function close() {
    if (signal.aborted) return;
    scope.abort();
    seen.disconnect();
    if (dialog.open) dialog.close();
    dialog.remove();
    o.opener.focus();
  }
  dialog.addEventListener("close", () => close(), { signal });

  await loadStylesheet(h);
  if (signal.aborted) return;
  document.body.append(dialog);
  dialog.showModal();
  update();
  if (!all.length) {
    status.textContent = "You have no collections yet. Save images and videos from the chat to one first.";
    return;
  }
  show();
  select.focus();
}

// ---------------------------------------------------------------- a new collection

export interface CreateOptions extends Base {
  opener: HTMLElement;
  /** Made: e.g. go to its page. */
  onCreated: (id: string) => void;
}

/** The sidebar's "+" (§31): a name, and whether anyone may see it. */
export async function openCreate(o: CreateOptions): Promise<void> {
  const { h } = o;
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(), { signal });
  const title = h("h2", { id: "coll-create-title" }, [icon(h), " New collection"]);
  const input = h("input", { required: true, autocomplete: "off", "aria-label": "Name", placeholder: "Name" });
  const pub = h("input", { type: "checkbox" });
  const err = h("p", { class: "coll-status", role: "alert" });
  const submit = h("button", { type: "submit" }, "Create");
  const form = h(
    "form",
    {
      class: "coll-body",
      on: {
        submit: async (e) => {
          e.preventDefault();
          if (submit.disabled) return;
          submit.disabled = true;
          err.textContent = "";
          try {
            const { id } = await calls(o.api).create(o.me()?.id ?? "", input.value, pub.checked);
            o.service.refresh();
            close(false);
            o.onCreated(id);
          } catch (e) {
            const x = e as { fields?: Record<string, string>; message?: string };
            err.textContent = Object.values(x.fields ?? {})[0] || x.message || "Couldn't create it.";
          } finally {
            submit.disabled = false;
          }
        },
      },
      signal,
    },
    [h("p", { class: "coll-new-form" }, [input, submit]), h("label", {}, [pub, " Public: anyone can see it and subscribe"]), err],
  );
  const dialog = h("dialog", { class: "coll-dialog coll-create", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", { type: "button", class: "link", "aria-label": "Close", on: { click: () => close() }, signal }, "×"),
    ]),
    form,
  ]);
  function close(refocus = true) {
    if (signal.aborted) return;
    scope.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    if (refocus) o.opener.focus();
  }
  dialog.addEventListener("close", () => close(), { signal });
  await loadStylesheet(h);
  if (signal.aborted) return;
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}
