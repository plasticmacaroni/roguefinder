// Share-code codec: build set ↔ compact base64url string.
//
// Two wire formats; encoder picks whichever is smaller, decoder dispatches
// on byte 0 (version).
//
//   0x01 = bitset over feat indices, LSB-first within each byte. Trailing
//          all-zero bytes stripped. Wins on dense builds (many selections).
//   0x02 = sorted varint-delta list of feat indices. Each index is the
//          previous index + a uleb128 varint delta. Wins on sparse builds,
//          including 'one feat near the end of the dataset' which is awful
//          for bitset (megabytes of interior zeros).
//
// Typical builds (1-100 feats) compress to <300 chars under format 0x02.

const VERSION_BITSET = 0x01;
const VERSION_LIST   = 0x02;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// ---- bitset helpers ----

function toBitset(build, indexOfId) {
  // Find the highest-set bit so we can right-trim.
  let maxIdx = -1;
  for (const id of build) {
    const i = indexOfId.get(id);
    if (i == null) continue;
    if (i > maxIdx) maxIdx = i;
  }
  if (maxIdx < 0) return new Uint8Array(0);
  const byteLen = Math.floor(maxIdx / 8) + 1;
  const bytes = new Uint8Array(byteLen);
  for (const id of build) {
    const i = indexOfId.get(id);
    if (i == null) continue;
    bytes[i >> 3] |= 1 << (i & 7);
  }
  return bytes;
}

function fromBitset(bytes, byIndex) {
  const set = new Set();
  for (let b = 0; b < bytes.length; b++) {
    const byte = bytes[b];
    if (!byte) continue;
    for (let bit = 0; bit < 8; bit++) {
      if (byte & (1 << bit)) {
        const idx = b * 8 + bit;
        const feat = byIndex[idx];
        if (feat) set.add(feat.id);
      }
    }
  }
  return set;
}

// ---- Sorted varint-delta list (uleb128) ----

function toIndexList(build, indexOfId) {
  const indices = [];
  for (const id of build) {
    const i = indexOfId.get(id);
    if (i != null) indices.push(i);
  }
  indices.sort((a, b) => a - b);
  const bytes = [];
  let prev = 0;
  for (const idx of indices) {
    let delta = idx - prev;
    while (delta >= 0x80) {
      bytes.push((delta & 0x7f) | 0x80);
      delta >>>= 7;
    }
    bytes.push(delta);
    prev = idx;
  }
  return new Uint8Array(bytes);
}

function fromIndexList(bytes, byIndex) {
  const set = new Set();
  let i = 0;
  let prev = 0;
  while (i < bytes.length) {
    let delta = 0;
    let shift = 0;
    let b;
    do {
      if (i >= bytes.length) throw new Error("share code: truncated varint");
      b = bytes[i++];
      delta |= (b & 0x7f) << shift;
      shift += 7;
      if (shift > 35) throw new Error("share code: varint too long");
    } while (b & 0x80);
    const idx = prev + delta;
    const feat = byIndex[idx];
    if (feat) set.add(feat.id);
    prev = idx;
  }
  return set;
}

// ---- base64url ----

function bytesToBase64Url(bytes) {
  // Build manually so we don't pay btoa-on-binary-strings overhead and so
  // we get base64url (no padding, URL-safe alphabet).
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += ALPHABET[b2 & 0x3f];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const b0 = bytes[i];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[(b0 & 0x03) << 4];
  } else if (rem === 2) {
    const b0 = bytes[i], b1 = bytes[i + 1];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += ALPHABET[(b1 & 0x0f) << 2];
  }
  return out;
}

function base64UrlToBytes(s) {
  // Reverse the alphabet for fast lookup.
  const decode = new Uint8Array(256).fill(0xff);
  for (let i = 0; i < ALPHABET.length; i++) decode[ALPHABET.charCodeAt(i)] = i;
  // Validate.
  for (let i = 0; i < s.length; i++) {
    if (decode[s.charCodeAt(i)] === 0xff) {
      throw new Error("invalid base64url character at position " + i);
    }
  }
  const fullChunks = Math.floor(s.length / 4);
  const rem = s.length - fullChunks * 4;
  if (rem === 1) throw new Error("invalid base64url length");
  const byteLen = fullChunks * 3 + (rem === 0 ? 0 : rem - 1);
  const out = new Uint8Array(byteLen);
  let j = 0;
  let p = 0;
  for (; p + 3 < s.length; p += 4) {
    const c0 = decode[s.charCodeAt(p)];
    const c1 = decode[s.charCodeAt(p + 1)];
    const c2 = decode[s.charCodeAt(p + 2)];
    const c3 = decode[s.charCodeAt(p + 3)];
    out[j++] = (c0 << 2) | (c1 >> 4);
    out[j++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    out[j++] = ((c2 & 0x03) << 6) | c3;
  }
  if (rem === 2) {
    const c0 = decode[s.charCodeAt(p)];
    const c1 = decode[s.charCodeAt(p + 1)];
    out[j++] = (c0 << 2) | (c1 >> 4);
  } else if (rem === 3) {
    const c0 = decode[s.charCodeAt(p)];
    const c1 = decode[s.charCodeAt(p + 1)];
    const c2 = decode[s.charCodeAt(p + 2)];
    out[j++] = (c0 << 2) | (c1 >> 4);
    out[j++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
  }
  return out;
}

// ---- public API ----

export function encodeBuild(build, indexOfId) {
  const bitset = toBitset(build, indexOfId);
  const list = toIndexList(build, indexOfId);
  const useList = list.length < bitset.length;
  const inner = useList ? list : bitset;
  const payload = new Uint8Array(1 + inner.length);
  payload[0] = useList ? VERSION_LIST : VERSION_BITSET;
  payload.set(inner, 1);
  return bytesToBase64Url(payload);
}

// Returns { build: Set<id>, version: number } or throws on invalid input.
export function decodeBuild(str, byIndex) {
  if (typeof str !== "string" || str.length === 0) {
    throw new Error("share code is empty");
  }
  const bytes = base64UrlToBytes(str);
  if (bytes.length === 0) throw new Error("share code is empty");
  const version = bytes[0];
  const inner = bytes.slice(1);
  let build;
  if (version === VERSION_BITSET) {
    build = fromBitset(inner, byIndex);
  } else if (version === VERSION_LIST) {
    build = fromIndexList(inner, byIndex);
  } else {
    throw new Error(`unsupported share-code version ${version}`);
  }
  return { build, version };
}
