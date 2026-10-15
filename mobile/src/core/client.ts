// The PocketBase client for the app: the web client (web/src/pb.ts: REST, auth store, realtime protocol, file URLs)
// with uploads that work on a phone. Files there are no Blobs but `{ uri, name, type }` objects, which React Native's
// FormData sends as file parts; progress comes from XHR, as on the web.

import { Platform } from "react-native";
import { type AuthStore, createClient, type PbClient, PbError, type RequestOptions } from "../shared";

/** A picked file (image picker, document picker, camera), as the app passes it where the web client takes a File. */
export interface NativeFile {
  uri: string;
  name: string;
  type: string;
  size: number;
}

export const isNativeFile = (v: unknown): v is NativeFile =>
  typeof v === "object" && v !== null && typeof (v as NativeFile).uri === "string" && typeof (v as NativeFile).name === "string";

const hasFiles = (v: unknown) => isNativeFile(v) || (Array.isArray(v) && v.some(isNativeFile));

/** A file part: React Native's FormData takes the object itself; a browser (react-native-web) needs a Blob. */
async function part(f: NativeFile): Promise<unknown> {
  if (Platform.OS !== "web") return { uri: f.uri, name: f.name, type: f.type || "application/octet-stream" };
  const blob = await (await fetch(f.uri)).blob();
  return new File([blob], f.name, { type: f.type || blob.type });
}

/** As the web client's toFormData: files and strings as fields, anything else in PocketBase's `@jsonPayload`. */
export async function toFormData(body: Record<string, unknown>): Promise<FormData> {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (hasFiles(v)) for (const f of [v].flat().filter(isNativeFile)) form.append(k, (await part(f)) as Blob);
    else if (typeof v === "string") form.append(k, v);
    else form.append("@jsonPayload", JSON.stringify({ [k]: v }));
  }
  return form;
}

const qs = (query: RequestOptions["query"] = {}) => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) if (v !== undefined) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

export function createNativeClient(baseUrl: string, authStore: AuthStore): PbClient {
  const base = baseUrl.replace(/\/+$/, "");
  const client = createClient(base, authStore);

  /** A request with files: multipart over XHR, with upload progress. Answers and errors as the web client's. */
  function upload<T>(path: string, { method = "POST", query, body = {}, onUpload }: RequestOptions): Promise<T> {
    return toFormData(body).then(
      (form) =>
        new Promise<T>((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open(method, base + path + qs(query));
          if (authStore.token) x.setRequestHeader("Authorization", authStore.token);
          x.setRequestHeader("Accept", "application/json");
          if (onUpload) x.upload.onprogress = (e) => e.lengthComputable && e.total && onUpload(e.loaded / e.total);
          x.onload = () => {
            let data: PbError["response"] = {};
            try {
              data = JSON.parse(x.responseText || "{}") ?? {};
            } catch {}
            if (x.status >= 400 || x.status === 0) reject(new PbError(x.status, data));
            else resolve(data as T);
          };
          x.onerror = () => reject(new PbError(0));
          x.onabort = () => reject(new PbError(0, {}, true));
          x.send(form);
        }),
    );
  }

  return {
    ...client,
    // Getters of the web client (authStore, realtime) are plain properties there: spreading keeps them.
    send<T>(path: string, opts: RequestOptions = {}): Promise<T> {
      if (opts.body && Object.values(opts.body).some(hasFiles)) return upload<T>(path, opts);
      return client.send<T>(path, opts);
    },
  };
}
