// The Android app's PocketBase client (mobile/src/core/client.ts): the shared web client, with uploads of picked files
// (`{ uri, name, type }`, not Blobs) as multipart over XHR, with progress.

import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { createNativeClient, isNativeFile, type NativeFile, toFormData } from "../../../mobile/src/core/client.ts";
import { createAuthStore, PbError } from "../../../web/src/pb.ts";

afterEach(() => {
  RecordingXhr.last = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const photo: NativeFile = { uri: "file:///cache/IMG_1.jpg", name: "IMG_1.jpg", type: "image/jpeg", size: 1234 };

describe("toFormData", () => {
  it("sends picked files as file parts, strings as fields, the rest as @jsonPayload", async () => {
    const append = vi.spyOn(FormData.prototype, "append");
    await toFormData({
      files: [photo, { ...photo, uri: "file:///b.pdf", name: "b.pdf", type: "" }],
      text: "hi",
      id: "x",
      reply: undefined,
      meta: { a: 1 },
    });
    const calls = append.mock.calls.map(([k, v]) => [k, typeof v === "string" ? v : { ...(v as object) }]);
    expect(calls).toEqual([
      ["files", { uri: photo.uri, name: "IMG_1.jpg", type: "image/jpeg" }],
      ["files", { uri: "file:///b.pdf", name: "b.pdf", type: "application/octet-stream" }],
      ["text", "hi"],
      ["id", "x"],
      ["@jsonPayload", JSON.stringify({ meta: { a: 1 } })],
    ]);
  });

  it("knows a picked file from other values", () => {
    expect(isNativeFile(photo)).toBe(true);
    expect(isNativeFile({ uri: "x" })).toBe(false);
    expect(isNativeFile("file:///x")).toBe(false);
    expect(isNativeFile(null)).toBe(false);
  });
});

/** Records one multipart request and answers it as the test says. */
class RecordingXhr {
  static last: RecordingXhr | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    RecordingXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
  }
  answer(status: number, json: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
}

describe("createNativeClient", () => {
  it("sends requests without files as the web client does (real server)", async () => {
    const client = createNativeClient(`${inject("pbUrl")}/`, createAuthStore());
    await expect(client.send<{ code: number }>("/api/health")).resolves.toMatchObject({ code: 200 });
    await expect(client.send("/api/collections/nope/records")).rejects.toBeInstanceOf(PbError);
  });

  it("uploads files over XHR with the session, the query and progress", async () => {
    vi.stubGlobal("XMLHttpRequest", RecordingXhr);
    const auth = createAuthStore();
    auth.save("token-1", { id: "u1", collectionName: "users" });
    const client = createNativeClient("https://chat.example.com", auth);
    const progress: number[] = [];
    const sent = client.send<{ id: string }>("/api/collections/messages/records", {
      method: "POST",
      query: { expand: "author", fields: "id,room" },
      body: { room: "r1", text: "", files: [photo] },
      onUpload: (f) => progress.push(f),
    });
    await vi.waitFor(() => expect(RecordingXhr.last?.body).toBeInstanceOf(FormData));
    const x = RecordingXhr.last!;
    expect(x.method).toBe("POST");
    expect(x.url).toBe("https://chat.example.com/api/collections/messages/records?expand=author&fields=id%2Croom");
    expect(x.headers.Authorization).toBe("token-1");
    x.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    x.answer(200, { id: "m1" });
    await expect(sent).resolves.toEqual({ id: "m1" });
    expect(progress).toEqual([0.5]);
  });

  it("rejects a refused upload with the server's field errors", async () => {
    vi.stubGlobal("XMLHttpRequest", RecordingXhr);
    const client = createNativeClient("https://chat.example.com", createAuthStore());
    const sent = client.send("/api/collections/users/records/u1", { method: "PATCH", body: { avatar: photo } });
    await vi.waitFor(() => expect(RecordingXhr.last?.body).toBeInstanceOf(FormData));
    expect(RecordingXhr.last!.headers.Authorization).toBeUndefined();
    RecordingXhr.last!.answer(400, {
      message: "Failed to update record.",
      data: { avatar: { code: "validation_file_size_limit", message: "Too big." } },
    });
    const err = await sent.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PbError);
    expect((err as PbError).status).toBe(400);
    expect((err as PbError).response.data?.avatar?.message).toBe("Too big.");
  });
});
