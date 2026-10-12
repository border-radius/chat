// Links in message text (§7.6.3). Pure, so what becomes a link is unit-tested.

/** A link found in text: what it shows, and where it goes. */
export interface Link {
  text: string;
  href: string;
}

/** Candidates: `http(s)://…` or `www.…`, up to whitespace or a character URLs don't contain unescaped. */
const CANDIDATE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
/**
 * Punctuation that ends a sentence rather than a URL ("see https://x.com." → no "."), typographic quotes ("„https://x.com“",
 * as phones type them) and CJK punctuation included.
 */
const TRAILING = /[.,:;!?'"*_…。\p{Pi}\p{Pf}]$/u;
/** A closing bracket, and the one that opens it. */
const OPENING: Record<string, string> = { ")": "(", "]": "[" };

/**
 * Split `text` into plain strings and links. Only http(s) URLs become links (`www.example.com` → https), so a
 * `javascript:` or `data:` URL never does. Trailing punctuation stays text, and so does a closing bracket the link
 * didn't open: "(see https://en.wikipedia.org/wiki/Rust_(language))" keeps the inner pair.
 */
export function linkify(text: string): (string | Link)[] {
  const out: (string | Link)[] = [];
  let at = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    let url = match[0];
    for (;;) {
      const last = url.slice(-1);
      const open = OPENING[last];
      if (!TRAILING.test(last) && !(open && count(url, open) < count(url, last))) break;
      url = url.slice(0, -1);
    }
    const www = /^www\./i.test(url);
    // Not the www. inside an email address or a longer host name (bob@www.example.com, my.www.example.com).
    if (www && /[@.-]/.test(text[match.index - 1] ?? "")) continue;
    // Always http(s), as that is all CANDIDATE matches.
    let href: string;
    try {
      href = new URL(www ? `https://${url}` : url).href;
    } catch {
      continue; // not a valid URL
    }
    if (match.index > at) out.push(text.slice(at, match.index));
    out.push({ text: url, href });
    at = match.index + url.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;
