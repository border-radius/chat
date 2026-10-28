// The collections' requests (§31), through Api.request: app.js doesn't carry them. ITEM_FIELDS is shared/contract.json's
// (tests/unit/contract.test.ts).

import type { Api } from "../../api.ts";
import type { CollectionItem } from "../../lib/types.ts";

/** What a collection's page shows of it. */
export interface Meta {
  id: string;
  name: string;
  public: boolean;
  owner: string;
  items: number;
}

/** A message's file (the one that has it: a forward's original, §21.3), or an item. */
export type From = { message: string; file: string } | { item: string };

/** A collection's page of items, as the media grid's (§30.2). */
export const PAGE = 60;

export const RECORDS = "/api/collections/collections/records";

/** A value in a records filter (ids and dates here), quoted and escaped. */
export const lit = (v: string) => JSON.stringify(v);

/** What a page of items asks for (shared/contract.json). */
export const ITEM_FIELDS = "id,collection,file,name,video,poster,created";

/** The requests of the page, the menu and the picker. */
export function calls(api: Api) {
  return {
    /** The collection, with its owner's name (guests can't look users up). */
    get: (id: string, signal: AbortSignal) =>
      api.request<Meta & { expand?: { owner?: { name: string } } }>(`${RECORDS}/${id}`, {
        query: { expand: "owner", fields: "id,name,public,owner,items,expand.owner.name" },
        signal,
      }),
    create: (owner: string, name: string, isPublic: boolean) =>
      api.request<{ id: string }>(RECORDS, { method: "POST", body: { owner, name, public: isPublic }, query: { fields: "id" } }),
    update: (id: string, body: { name?: string; public?: boolean }) =>
      api.request<Pick<Meta, "name" | "public">>(`${RECORDS}/${id}`, { method: "PATCH", body, query: { fields: "name,public" } }),
    remove: (id: string) => api.request(`${RECORDS}/${id}`, { method: "DELETE" }),
    /**
     * A page of a collection's items, newest first: older than `after` (the oldest shown), or the newest; with
     * `newer`, those added after `after` (the newest shown).
     */
    async items(collection: string, after: CollectionItem | undefined, signal: AbortSignal, newer = false) {
      const op = newer ? ">" : "<";
      const cursor = after
        ? ` && (created ${op} ${lit(after.created)} || (created = ${lit(after.created)} && id ${op} ${lit(after.id)}))`
        : "";
      const query = {
        filter: `collection = ${lit(collection)}${cursor}`,
        sort: "-created,-id",
        perPage: PAGE + 1,
        skipTotal: true,
        fields: ITEM_FIELDS,
      };
      const { items } = await api.request<{ items: CollectionItem[] }>("/api/collections/collection_items/records", { query, signal });
      return { items: items.slice(0, PAGE), more: items.length > PAGE };
    },
    /** The ids of a collection's items from `oldest` on (it included): which of those shown are still there. */
    async idsSince(collection: string, oldest: CollectionItem, signal: AbortSignal) {
      const ids = new Set<string>();
      const filter = `collection = ${lit(collection)} && (created > ${lit(oldest.created)} || (created = ${lit(oldest.created)} && id >= ${lit(oldest.id)}))`;
      for (let page = 1; ; page++) {
        const query = { filter, sort: "-created,-id", page, perPage: 1000, skipTotal: true, fields: "id" };
        const { items } = await api.request<{ items: { id: string }[] }>("/api/collections/collection_items/records", { query, signal });
        for (const x of items) ids.add(x.id);
        if (items.length < 1000) return ids;
      }
    },
    /** A copy of a message's file or of an item in a collection of yours. 409: it is in there already. */
    save: (collection: string, from: From) =>
      api.request<CollectionItem>("/api/chat/items", { method: "POST", body: { collection, ...from } }),
    /** An image or video of your own, uploaded straight into a collection of yours. */
    upload: (collection: string, file: File, onUpload: (fraction: number) => void) =>
      api.request<CollectionItem>("/api/chat/items", { method: "POST", body: { collection, file }, onUpload }),
    unsave: (item: string) => api.request(`/api/chat/items/${item}`, { method: "DELETE" }),
    /** Your collections that have the file already: collection id → item id. */
    savedIn: (from: From, signal: AbortSignal) => api.request<Record<string, string>>("/api/chat/saved", { query: from, signal }),
    follow: (collection: string, on: boolean) => api.request("/api/chat/subs", { method: "POST", body: { collection, on } }),
  };
}
