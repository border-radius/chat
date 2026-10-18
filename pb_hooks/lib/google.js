/// <reference path="../../types/pocketbase.d.ts" />
// An OAuth access token for a Google service account (docs/ANDROID.md §8.2: FCM's HTTP v1 API needs one): a JWT signed
// with the account's RSA key (RS256), traded at its token_uri. The JSVM has no RSA, so the signature is computed here:
// PKCS #1 v1.5 over SHA-256 with BigInt arithmetic (about 10 ms a token; one lasts an hour and is kept in the app store).

// ---------------------------------------------------------------- bytes

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** @param {string} s */
function fromBase64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  /** @type {number[]} */
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

/** @param {number[]} bytes */
function toBase64Url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

/** UTF-8 bytes of `s`. @param {string} s */
function utf8(s) {
  /** @type {number[]} */
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** @param {string} hex */
const fromHex = (hex) => (hex.match(/../g) ?? []).map((h) => parseInt(h, 16));

/** @param {number[]} bytes */
function toBig(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** @param {bigint} n @param {number} length */
function fromBig(n, length) {
  /** @type {number[]} */
  const out = new Array(length).fill(0);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

// ---------------------------------------------------------------- the key

/**
 * The DER elements of a SEQUENCE at `at`: [tag, start, end] each.
 * @param {number[]} der
 * @param {number} at
 */
function elements(der, at) {
  /** @param {number} i */
  const header = (i) => {
    const tag = der[i];
    let len = der[i + 1];
    let start = i + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + der[i + 2 + k];
      start = i + 2 + n;
    }
    return { tag, start, end: start + len };
  };
  const seq = header(at);
  /** @type {{ tag: number, start: number, end: number }[]} */
  const out = [];
  for (let i = seq.start; i < seq.end; ) {
    const el = header(i);
    out.push(el);
    i = el.end;
  }
  return out;
}

/**
 * n and d of a PEM private key: PKCS #8 ("PRIVATE KEY", as service accounts have them) or PKCS #1 ("RSA PRIVATE KEY").
 * @param {string} pem
 */
function rsaKey(pem) {
  let der = fromBase64(pem.replace(/-----[^-]+-----/g, ""));
  let fields = elements(der, 0);
  // PKCS #8: version, algorithm, OCTET STRING holding the PKCS #1 key.
  if (fields.length === 3 && fields[2].tag === 0x04) {
    der = der.slice(fields[2].start, fields[2].end);
    fields = elements(der, 0);
  }
  /** @param {number} i */
  const int = (i) => toBig(der.slice(fields[i].start, fields[i].end));
  const n = int(1);
  const d = int(3);
  return { n, d, size: (n.toString(16).length + 1) >> 1 };
}

/** @param {bigint} base @param {bigint} exp @param {bigint} mod */
function modPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
  }
  return r;
}

/** DigestInfo of SHA-256 (RFC 8017 §9.2). */
const SHA256_PREFIX = fromHex("3031300d060960864801650304020105000420");

/**
 * RS256 signature of `input` (ASCII) with `key`.
 * @param {string} input
 * @param {{ n: bigint, d: bigint, size: number }} key
 */
function rs256(input, key) {
  const t = [...SHA256_PREFIX, ...fromHex($security.sha256(input))];
  const em = [0, 1, ...new Array(key.size - t.length - 3).fill(0xff), 0, ...t];
  return fromBig(modPow(toBig(em), key.d, key.n), key.size);
}

/**
 * A signed JWT for `claims`.
 * @param {Record<string, unknown>} claims
 * @param {string} pem
 */
function signJwt(claims, pem) {
  const part = (/** @type {unknown} */ o) => toBase64Url(utf8(JSON.stringify(o)));
  const input = `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}`;
  return `${input}.${toBase64Url(rs256(input, rsaKey(pem)))}`;
}

// ---------------------------------------------------------------- the token

/**
 * An access token for `account` (a service account's JSON, parsed) with `scope`: the one kept in the app store while it
 * has over a minute left, else a new one. Throws when the token endpoint refuses.
 * @param {core.App} app
 * @param {{ client_email: string, private_key: string, token_uri?: string }} account
 * @param {string} scope
 */
function accessToken(app, account, scope) {
  const key = `google.token.${account.client_email}.${scope}`;
  const kept = /** @type {{ token: string, until: number } | null} */ (app.store().get(key));
  if (kept && kept.until - Date.now() > 60_000) return kept.token;
  const uri = account.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({ iss: account.client_email, scope, aud: uri, iat: now, exp: now + 3600 }, account.private_key);
  const res = $http.send({
    url: uri,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
    timeout: 15,
  });
  if (res.statusCode !== 200 || !res.json?.access_token) throw new Error(`token endpoint answered ${res.statusCode}`);
  const token = String(res.json.access_token);
  app.store().set(key, { token, until: Date.now() + Number(res.json.expires_in || 3600) * 1000 });
  return token;
}

module.exports = { accessToken, signJwt, rsaKey, rs256, toBase64Url, fromBase64, utf8 };
