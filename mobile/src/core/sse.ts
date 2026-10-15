// EventSource for React Native (PocketBase realtime is Server-Sent Events, §7.5): a streaming XHR whose text is parsed
// as it arrives. Only what the shared client (web/src/pb.ts) uses: named events with `data` and `lastEventId`,
// `onerror`, and `close()`. It never reconnects by itself: the client does, with its own backoff and resubscribe.

type Listener = (e: SseEvent) => void;

export interface SseEvent {
  type: string;
  data: string;
  lastEventId: string;
}

/** One parsed event block, or null for a comment or keep-alive. */
export interface Parsed {
  event: string;
  data: string;
  id: string | undefined;
}

/**
 * Split `buffer` into complete events (each ends with a blank line) and what is left over: the start of the next
 * one. Lines end with \n, \r\n or \r (the SSE spec allows all three).
 */
export function parseChunk(buffer: string): { events: Parsed[]; rest: string } {
  const events: Parsed[] = [];
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    let id: string | undefined;
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length || id !== undefined) events.push({ event, data: data.join("\n"), id });
  }
  return { events, rest };
}

/** Every open stream, so that coming back to the app can restart them (Android drops sockets in the background). */
const open = new Set<NativeEventSource>();

/** Fail every open stream: the client sees a lost connection, reconnects and catches up on what it missed. */
export function reviveAll(): void {
  for (const es of [...open]) es.fail();
}

export class NativeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = NativeEventSource.CONNECTING;
  onerror: ((e: unknown) => void) | null = null;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: Listener | null = null;

  private readonly listeners = new Map<string, Set<Listener>>();
  private xhr: XMLHttpRequest | null;
  private seen = 0;
  private buffer = "";
  private lastId = "";

  constructor(url: string) {
    this.url = url;
    const xhr = new XMLHttpRequest();
    this.xhr = xhr;
    xhr.open("GET", url);
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.setRequestHeader("Cache-Control", "no-cache");
    xhr.timeout = 0;
    // A listener for progress makes React Native deliver the body in pieces as it arrives, not all at the end.
    xhr.onprogress = () => this.read();
    xhr.onreadystatechange = () => {
      if (this.xhr !== xhr) return;
      if (xhr.readyState === 2 || xhr.readyState === 3) {
        if (this.readyState === NativeEventSource.CONNECTING && xhr.status === 200) {
          this.readyState = NativeEventSource.OPEN;
          this.onopen?.({ type: "open" });
        }
        this.read();
      } else if (xhr.readyState === 4) {
        this.read();
        this.fail(); // the server closed the stream (or never opened it): the client decides what next
      }
    };
    xhr.onerror = () => this.xhr === xhr && this.fail();
    open.add(this);
    xhr.send();
  }

  private read() {
    const text = this.xhr?.responseText ?? "";
    if (text.length <= this.seen) return;
    this.buffer += text.slice(this.seen);
    this.seen = text.length;
    const { events, rest } = parseChunk(this.buffer);
    this.buffer = rest;
    for (const e of events) {
      if (e.id !== undefined) this.lastId = e.id;
      const ev: SseEvent = { type: e.event, data: e.data, lastEventId: this.lastId };
      if (e.event === "message") this.onmessage?.(ev);
      for (const fn of [...(this.listeners.get(e.event) ?? [])]) fn(ev);
      if (this.readyState === NativeEventSource.CLOSED) return; // a listener closed it
    }
  }

  /** The connection is gone: say so once, like a browser's EventSource that won't retry. */
  fail(): void {
    if (this.readyState === NativeEventSource.CLOSED) return;
    this.close();
    this.onerror?.({ type: "error" });
  }

  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  close(): void {
    this.readyState = NativeEventSource.CLOSED;
    open.delete(this);
    const xhr = this.xhr;
    this.xhr = null;
    xhr?.abort();
  }
}
