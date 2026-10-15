// The Android app's EventSource (mobile/src/core/sse.ts): the parser, the stream over a streaming XHR like React
// Native's, and PocketBase realtime through the shared client (web/src/pb.ts) with it, against the real server.

import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { NativeEventSource, parseChunk, reviveAll } from "../../../mobile/src/core/sse.ts";
import { type Api, createApi } from "../../../web/src/api.ts";
import { newId } from "../../../web/src/lib/id.ts";
import type { Message } from "../../../web/src/lib/types.ts";
import { createClient } from "../../../web/src/pb.ts";
import { uniq } from "../../support/ids.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseChunk", () => {
  it("splits complete events from the start of the next one", () => {
    const { events, rest } = parseChunk('id:abc\nevent:PB_CONNECT\ndata:{"clientId":"abc"}\n\nevent:messages/*\ndata:{"a"');
    expect(events).toEqual([{ event: "PB_CONNECT", data: '{"clientId":"abc"}', id: "abc" }]);
    expect(rest).toBe('event:messages/*\ndata:{"a"');
  });

  it("joins data lines, takes any line ending, and skips comments and keep-alives", () => {
    const { events, rest } = parseChunk(": ping\r\n\r\nevent: x\r\ndata: one\r\ndata: two\r\n\r\ndata\n\n");
    expect(events).toEqual([
      { event: "x", data: "one\ntwo", id: undefined },
      { event: "message", data: "", id: undefined },
    ]);
    expect(rest).toBe("");
  });
});

/** An XHR that the test feeds by hand, as React Native's delivers a streamed body: a growing responseText. */
class ScriptedXhr {
  static last: ScriptedXhr | null = null;
  readyState = 0;
  status = 0;
  responseText = "";
  timeout = -1;
  aborted = false;
  headers: Record<string, string> = {};
  onprogress: (() => void) | null = null;
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    ScriptedXhr.last = this;
  }
  open() {
    this.readyState = 1;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {}
  abort() {
    this.aborted = true;
  }
  push(text: string) {
    this.status = 200;
    this.readyState = 3;
    this.responseText += text;
    this.onprogress?.();
    this.onreadystatechange?.();
  }
  end() {
    this.readyState = 4;
    this.onreadystatechange?.();
  }
}

describe("NativeEventSource", () => {
  it("delivers named events with their id, across chunk boundaries", () => {
    vi.stubGlobal("XMLHttpRequest", ScriptedXhr);
    const es = new NativeEventSource("http://x/api/realtime");
    const xhr = ScriptedXhr.last!;
    expect(xhr.headers.Accept).toBe("text/event-stream");
    expect(xhr.timeout).toBe(0);
    const got: unknown[] = [];
    es.addEventListener("PB_CONNECT", (e) => got.push(["connect", e.lastEventId, e.data]));
    es.addEventListener("messages/*", (e) => got.push(["msg", e.data]));
    xhr.push('id:c1\nevent:PB_CONNECT\ndata:{"clientId":');
    expect(got).toEqual([]);
    xhr.push('"c1"}\n\nevent:messages/*\ndata:{"n":1}\n\n');
    expect(got).toEqual([
      ["connect", "c1", '{"clientId":"c1"}'],
      ["msg", '{"n":1}'],
    ]);
    expect(es.readyState).toBe(NativeEventSource.OPEN);
  });

  it("reports the end of the stream once, as an error (the client reconnects), and stops listening", () => {
    vi.stubGlobal("XMLHttpRequest", ScriptedXhr);
    const es = new NativeEventSource("http://x/api/realtime");
    const xhr = ScriptedXhr.last!;
    const onerror = vi.fn();
    es.onerror = onerror;
    const onmsg = vi.fn();
    es.addEventListener("x", onmsg);
    xhr.push("event:x\ndata:1\n\n");
    xhr.end();
    xhr.onerror?.();
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(es.readyState).toBe(NativeEventSource.CLOSED);
    expect(xhr.aborted).toBe(true);
    expect(onmsg).toHaveBeenCalledTimes(1);
  });

  it("close() is silent; reviveAll() fails the open streams", () => {
    vi.stubGlobal("XMLHttpRequest", ScriptedXhr);
    const a = new NativeEventSource("http://x/a");
    const b = new NativeEventSource("http://x/b");
    a.onerror = vi.fn();
    b.onerror = vi.fn();
    a.close();
    reviveAll();
    expect(a.onerror).not.toHaveBeenCalled();
    expect(b.onerror).toHaveBeenCalledTimes(1);
  });
});

/** React Native's XHR, near enough: fetch's streamed body as a growing responseText. */
class StreamingXhr {
  readyState = 0;
  status = 0;
  responseText = "";
  timeout = 0;
  onprogress: (() => void) | null = null;
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = "";
  private headers: Record<string, string> = {};
  private ac = new AbortController();
  open(_method: string, url: string) {
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {
    void (async () => {
      try {
        const res = await fetch(this.url, { headers: this.headers, signal: this.ac.signal });
        this.status = res.status;
        this.readyState = 2;
        this.onreadystatechange?.();
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.responseText += decoder.decode(value, { stream: true });
          this.readyState = 3;
          this.onprogress?.();
          this.onreadystatechange?.();
        }
        this.readyState = 4;
        this.onreadystatechange?.();
      } catch {
        if (!this.ac.signal.aborted) this.onerror?.();
      }
    })();
  }
  abort() {
    this.ac.abort();
  }
}

describe("realtime through NativeEventSource (real server)", () => {
  let api: Api | null = null;
  afterEach(async () => {
    await api?.unsubscribeAll().catch(() => {});
    api = null;
  });

  it("subscribes, receives live messages, and carries on after the app comes back (reviveAll)", async () => {
    vi.stubGlobal("XMLHttpRequest", StreamingXhr);
    vi.stubGlobal("EventSource", NativeEventSource);
    api = createApi(createClient(inject("pbUrl")));
    await api.signUp({ email: `${uniq()}@test.local`, password: "password123", name: `mobile-${uniq()}` });
    const room = await api.createRoom(`m-${uniq()}`);
    const seen: Message[] = [];
    const connects: boolean[] = [];
    api.onConnect((reconnect) => connects.push(reconnect));
    await api.subscribeMessages(room.id, (action, m) => action === "create" && seen.push(m));

    await api.send({ id: newId(), room: room.id, text: "first" });
    await vi.waitFor(() => expect(seen.map((m) => m.text)).toEqual(["first"]), { timeout: 5000 });
    expect(seen[0]!.expand?.author?.name).toMatch(/^mobile-/);

    // Back from the background: the stream is started over, the subscriptions sent again.
    reviveAll();
    await vi.waitFor(() => expect(connects).toContain(true), { timeout: 5000 });
    await api.send({ id: newId(), room: room.id, text: "second" });
    await vi.waitFor(() => expect(seen.map((m) => m.text)).toEqual(["first", "second"]), { timeout: 5000 });
  });
});
