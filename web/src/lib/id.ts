// Client-generated record ids (§7.5): PocketBase's default id format, 15 chars of [a-z0-9].

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LENGTH = 15;
// Largest multiple of 36 below 256: bytes at or above it are rejected to avoid modulo bias.
const LIMIT = 256 - (256 % ALPHABET.length);

export function newId(): string {
  let id = "";
  const buf = new Uint8Array(LENGTH * 2);
  while (id.length < LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < LIMIT) id += ALPHABET[b % ALPHABET.length];
      if (id.length === LENGTH) break;
    }
  }
  return id;
}
