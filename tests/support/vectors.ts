// Reading shared/vectors/window.json (docs/API.md): messages are written out, or as `{ "gen": [from, to] }`, a run of
// messages "m0001"… by one author a second apart from 2026-10-01 10:00:00 (in that order: [60, 11] is newest first).
// android/core/data/src/test/kotlin/chirkle/android/data/lib/WindowVectorsTest.kt reads them the same way.

import type { Message } from "../../web/src/lib/types.ts";

export type MessageSpec = Partial<Message> & { id: string };
export type Messages = (MessageSpec | { gen: [number, number] })[];

/** The `i`th generated message's id and time. */
export const genId = (i: number): string => `m${String(i).padStart(4, "0")}`;
export function genCreated(i: number): string {
  const s = 10 * 3600 + i;
  const two = (n: number) => String(n).padStart(2, "0");
  return `2026-10-01 ${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}.000Z`;
}

export function message(spec: MessageSpec): Message {
  return {
    room: "r",
    author: "a",
    text: "",
    created: spec.created ?? "",
    updated: spec.updated ?? spec.created ?? "",
    deleted: false,
    ...spec,
  } as Message;
}

export function messages(list: Messages): Message[] {
  return list.flatMap((m) => {
    if (!("gen" in m)) return [message(m)];
    const [from, to] = m.gen;
    const step = from <= to ? 1 : -1;
    const out: Message[] = [];
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) out.push(message({ id: genId(i), created: genCreated(i) }));
    return out;
  });
}
