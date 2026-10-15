import { describe, expect, it } from "vitest";
import { authKey, displayUrl, isInsecure, normalizeUrl } from "../../../mobile/src/core/urls.ts";

describe("server addresses (Android app)", () => {
  it("takes a bare host as https", () => {
    expect(normalizeUrl("chat.example.com")).toBe("https://chat.example.com");
    expect(normalizeUrl("  Chat.Example.com/  ")).toBe("https://chat.example.com");
  });

  it("keeps an explicit http://, a port and a path prefix", () => {
    expect(normalizeUrl("http://192.168.1.20:8090")).toBe("http://192.168.1.20:8090");
    expect(normalizeUrl("https://example.com/chat/")).toBe("https://example.com/chat");
  });

  it("drops the app's own pages from a pasted link", () => {
    expect(normalizeUrl("https://chat.example.com/r/abc123")).toBe("https://chat.example.com");
    expect(normalizeUrl("https://chat.example.com/r/abc123/m/xyz")).toBe("https://chat.example.com");
    expect(normalizeUrl("https://example.com/chat/login")).toBe("https://example.com/chat");
    expect(normalizeUrl("https://chat.example.com/_/")).toBe("https://chat.example.com");
    expect(normalizeUrl("https://chat.example.com/me")).toBe("https://chat.example.com");
  });

  it("refuses what can't be a server, saying why", () => {
    expect(() => normalizeUrl("")).toThrow("Enter the server's address.");
    expect(() => normalizeUrl("ftp://example.com")).toThrow("https:// or http://");
    expect(() => normalizeUrl("http://exa mple.com")).toThrow("doesn't look like a web address");
  });

  it("shows https addresses without the scheme, and flags http ones", () => {
    expect(displayUrl("https://chat.example.com")).toBe("chat.example.com");
    expect(displayUrl("http://10.0.0.2:8090")).toBe("http://10.0.0.2:8090");
    expect(isInsecure("http://10.0.0.2:8090")).toBe(true);
    expect(isInsecure("https://chat.example.com")).toBe(false);
  });

  it("gives each server its own secure-store key, in the characters it allows", () => {
    const a = authKey("https://chat.example.com");
    const b = authKey("https://chat.example.com/other");
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(b).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(a).not.toBe(b);
    expect(authKey("https://chat.example.com")).toBe(a);
  });
});
