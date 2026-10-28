// The room controller's shared scenarios (shared/vectors/room.json): the web's controller.ts against a real PocketBase.
// The app runs the same in android/core/data/src/test/kotlin/chirkle/android/data/repo/RoomScenariosTest.kt.
// RECORD=1 writes what the web's controller does as each step's `expect` (the reference the app is held to).

import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../../../web/src/lib/id.ts";
import type { Message } from "../../../../web/src/lib/types.ts";
import { createScope, type Scope } from "../../../../web/src/scope.ts";
import { type AppState, createStore, initialState, type Store, upsertRoom } from "../../../../web/src/store.ts";
import { createRoomController, type RoomController } from "../../../../web/src/views/room/controller.ts";
import { type SignedUp, signedUp, uniq } from "../../../support/api.ts";

const FILE = "shared/vectors/room.json";
const RECORD = process.env.RECORD === "1";
const vectors = JSON.parse(readFileSync(FILE, "utf8")) as { scenarios: Scenario[] };

interface Step {
  do: "open" | "loadEdge" | "jump" | "goTo" | "atBottom" | "say" | "delete";
  at?: string;
  side?: "top" | "bottom";
  to?: "latest" | "first";
  value?: boolean;
  who?: "author" | "other";
  text?: string;
  expect?: Shown;
}
interface Scenario {
  name: string;
  seed: number;
  reader?: "author" | "other";
  readUpTo?: string;
  steps: Step[];
}
interface Shown {
  first: string | null;
  last: string | null;
  count: number;
  hasOlder: boolean;
  hasNewer: boolean;
  phase: string;
  target: string | null;
  unread: string | null;
  pill: string | null;
  deleted: string[];
}

describe("shared scenarios: the room controller (§7.5)", () => {
  let scope: Scope | undefined;
  const users: SignedUp[] = [];
  afterEach(async () => {
    scope?.dispose();
    scope = undefined;
    await Promise.all(users.splice(0).map((u) => u.api.unsubscribeAll()));
  });
  afterAll(() => {
    if (RECORD) writeFileSync(FILE, `${JSON.stringify(vectors, null, 2)}\n`);
  });

  for (const sc of vectors.scenarios) {
    it(sc.name, async () => {
      const [author, other] = await Promise.all([signedUp(`Author ${uniq()}`), signedUp(`Other ${uniq()}`)]);
      users.push(author, other);
      const room = await author.api.createRoom(`room-${uniq()}`);
      const label = new Map<string, string>(); // id → label
      const idOf = (l: string) => [...label].find(([, v]) => v === l)![0];
      for (let i = 1; i <= sc.seed; i++) {
        const m = await author.api.send({ id: newId(), room: room.id, text: `m${i}` });
        label.set(m.id, `m${i}`);
      }
      const reader = sc.reader === "other" ? other : author;
      if (sc.readUpTo) {
        const page = await reader.api.page({ filter: "room = {:room}", params: { room: room.id }, sort: "created,id" });
        await reader.api.markRead(room.id, page.find((m) => m.id === idOf(sc.readUpTo!))!.created);
      }
      const counts = await reader.api.unreadCounts();
      const base: AppState = { ...initialState(), user: reader.user, roomsStatus: "ready", unread: new Map(Object.entries(counts.rooms)) };
      const store: Store<AppState> = createStore<AppState>({ ...base, ...upsertRoom(room)(base) });
      let atBottom = true;
      let ctl: RoomController | undefined;
      const shown = (): Shown => {
        const s = ctl!.state();
        const items: Message[] = s.win.items;
        const of = (id: string | null) => (id ? (label.get(id) ?? id) : null);
        return {
          first: of(items[0]?.id ?? null),
          last: of(items.at(-1)?.id ?? null),
          count: items.length,
          hasOlder: s.win.hasOlder,
          hasNewer: s.win.hasNewer,
          phase: s.phase,
          target: of(s.targetId),
          unread: of(s.unreadId),
          pill: s.pill,
          deleted: items.filter((m) => m.deleted).map((m) => of(m.id)!),
        };
      };

      for (const [i, step] of sc.steps.entries()) {
        switch (step.do) {
          case "open":
            scope = createScope();
            ctl = createRoomController({
              api: reader.api,
              store,
              roomId: room.id,
              msgId: step.at ? idOf(step.at) : undefined,
              scope,
              nearBottom: () => atBottom,
              onChange: () => {},
            });
            ctl.start();
            break;
          case "loadEdge":
            void ctl!.loadEdge(step.side!);
            break;
          case "jump":
            void ctl!.jump(step.to!);
            break;
          case "goTo":
            void ctl!.goTo(idOf(step.at!));
            break;
          case "atBottom":
            atBottom = step.value!;
            break;
          case "say": {
            const who = step.who === "other" ? other : author;
            const m = await who.api.send({ id: newId(), room: room.id, text: step.text! });
            label.set(m.id, step.text!);
            break;
          }
          case "delete":
            await author.api.softDelete(idOf(step.at!));
            break;
        }
        if (RECORD) {
          // Settled: loaded, and the same for a second (a step's page, or a live event, takes a moment to come).
          await vi.waitFor(() => expect(ctl!.state().phase).not.toBe("loading"), { timeout: 10_000 });
          let last = "";
          for (let still = 0; still < 10; ) {
            await new Promise((r) => setTimeout(r, 100));
            const now = JSON.stringify(shown());
            still = now === last ? still + 1 : 0;
            last = now;
          }
          step.expect = shown();
        } else {
          await vi.waitFor(() => expect(shown(), `step ${i + 1}: ${step.do}`).toEqual(step.expect), { timeout: 10_000, interval: 25 });
        }
      }
    }, 60_000);
  }
});
