// URL hash routing for shared builds. Format: #b/<base64url>
// main.js captures and clears the hash IMMEDIATELY at boot (before any
// await) so the URL bar normalizes to the site address before the page
// even finishes loading. We then apply the captured code after data loads.

import { decodeBuild, encodeBuild } from "./share-codec.js";
import { showToast } from "./toast.js";

const PREFIX = "#b/";

// Decode a previously-captured share code against the loaded byIndex.
// Returns Set<id> or null on failure (with a user-facing toast on error).
export function applyShareCode(code, byIndex) {
  if (!code) return null;
  try {
    const { build } = decodeBuild(code, byIndex);
    return build;
  } catch (err) {
    showToast(`Couldn't load shared build: ${err.message}`);
    return null;
  }
}

export function buildShareUrl(build, indexOfId) {
  const code = encodeBuild(build, indexOfId);
  const base = `${location.origin}${location.pathname}${location.search}`;
  return `${base}${PREFIX}${code}`;
}
