import { describe, expect, it } from "vitest";
import { linkify } from "../../../web/src/lib/links.ts";

const link = (text: string, href = text) => ({ text, href });

describe("linkify", () => {
  it("leaves text without links as it is", () => {
    expect(linkify("hello there")).toEqual(["hello there"]);
    expect(linkify("")).toEqual([]);
  });

  it("finds http and https URLs, with the text around them", () => {
    expect(linkify("see https://example.com/a?b=1#c now")).toEqual(["see ", link("https://example.com/a?b=1#c"), " now"]);
    expect(linkify("http://example.com")).toEqual([link("http://example.com", "http://example.com/")]);
    expect(linkify("a https://a.io b https://b.io")).toEqual([
      "a ",
      link("https://a.io", "https://a.io/"),
      " b ",
      link("https://b.io", "https://b.io/"),
    ]);
  });

  it("links www. addresses over https", () => {
    expect(linkify("go to www.example.com")).toEqual(["go to ", link("www.example.com", "https://www.example.com/")]);
  });

  it("keeps the punctuation that ends a sentence out of the link", () => {
    expect(linkify("look: https://example.com/x.")).toEqual(["look: ", link("https://example.com/x"), "."]);
    expect(linkify("https://example.com/x?!")).toEqual([link("https://example.com/x"), "?!"]);
    expect(linkify(`"https://example.com/x",`)).toEqual([`"`, link("https://example.com/x"), `",`]);
  });

  it("keeps typographic quotes, an ellipsis and CJK punctuation out of the link", () => {
    expect(linkify("„https://example.com/x“")).toEqual(["„", link("https://example.com/x"), "“"]);
    expect(linkify("‘https://example.com/x’ «https://example.com/y»")).toEqual([
      "‘",
      link("https://example.com/x"),
      "’ «",
      link("https://example.com/y"),
      "»",
    ]);
    expect(linkify("https://example.com…")).toEqual([link("https://example.com", "https://example.com/"), "…"]);
    expect(linkify("见https://example.com/x。")).toEqual(["见", link("https://example.com/x"), "。"]);
  });

  it("doesn't link the www. inside an email address or a longer host name", () => {
    for (const text of ["bob@www.example.com", "my.www.example.com", "x-www.example.com"]) expect(linkify(text)).toEqual([text]);
    expect(linkify("end.https://example.com/x")).toEqual(["end.", link("https://example.com/x")]);
  });

  it("keeps a closing bracket the link didn't open out of it, and one it did in it", () => {
    expect(linkify("(see https://example.com/x)")).toEqual(["(see ", link("https://example.com/x"), ")"]);
    expect(linkify("https://en.wikipedia.org/wiki/Rust_(language)")).toEqual([link("https://en.wikipedia.org/wiki/Rust_(language)")]);
    expect(linkify("(https://en.wikipedia.org/wiki/Rust_(language)).")).toEqual([
      "(",
      link("https://en.wikipedia.org/wiki/Rust_(language)"),
      ").",
    ]);
    expect(linkify("[https://example.com/x]")).toEqual(["[", link("https://example.com/x"), "]"]);
  });

  it("never links anything but http(s)", () => {
    for (const text of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "mailto:a@example.com",
      "ftp://example.com",
    ]) {
      expect(linkify(text)).toEqual([text]);
    }
    // Not a URL at all: stays text.
    expect(linkify("http:// nothing")).toEqual(["http:// nothing"]);
    // Inside a word, "http" doesn't start a link.
    expect(linkify("xhttps://example.com")).toEqual(["xhttps://example.com"]);
  });

  it("stops at characters URLs don't contain unescaped", () => {
    expect(linkify(`<https://example.com/x>`)).toEqual(["<", link("https://example.com/x"), ">"]);
    expect(linkify(`https://example.com/"onmouseover="x`)).toEqual([link("https://example.com/"), `"onmouseover="x`]);
  });
});
