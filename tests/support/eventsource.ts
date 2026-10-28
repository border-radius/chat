// happy-dom swaps the DOM globals that Node's built-in EventSource relies on, and it then never connects.
// The fetch-based `eventsource` package works there, so the component project installs it for the PocketBase SDK.
import { EventSource } from "eventsource";

globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
