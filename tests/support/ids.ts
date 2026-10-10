// Unique names for test fixtures (rooms, users, emails): every test file shares one server, often in parallel.

let seq = 0;

/** time + per-process counter + random, e.g. "mgk2x1a0f3k9q": unique across parallel workers. */
export const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
