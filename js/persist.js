// localStorage persistence: build (Set<featId>), filters, search query.
// Reads on boot (before render), writes debounced after user changes.
// All localStorage access is try/catch-wrapped so private-browsing / quota
// failures degrade gracefully (PERS-03).

import { debounce } from "./util/debounce.js";
import { showToast } from "./toast.js";

const KEYS = {
  build: "feat-chooser:build",
  filters: "feat-chooser:filters",
  query: "feat-chooser:query",
  picks: "feat-chooser:picks",
};

let warned = false;
function warnOnce(err) {
  if (warned) return;
  warned = true;
  console.warn("Persistence warning:", err);
  showToast("Couldn't save to your browser — your build won't survive a reload.");
}

function safeRead(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

function safeWrite(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    warnOnce(err);
  }
}

// ---- Build (Set<id>) ----

export function loadBuild() {
  const raw = safeRead(KEYS.build);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

export const saveBuild = debounce((build) => {
  if (!(build instanceof Set)) return;
  safeWrite(KEYS.build, JSON.stringify([...build]));
}, 200);

// ---- Filters ----

export function loadFilters() {
  const raw = safeRead(KEYS.filters);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    const w = obj.weights && typeof obj.weights === "object" ? obj.weights : {};
    const wt = w.types    && typeof w.types    === "object" ? w.types    : {};
    const wl = w.levels   && typeof w.levels   === "object" ? w.levels   : {};
    const wr = w.rarities && typeof w.rarities === "object" ? w.rarities : {};
    // Coerce numeric values; drop garbage.
    const cleanTypeWeights = {};
    for (const [k, v] of Object.entries(wt)) {
      const n = Number(v);
      if (Number.isFinite(n)) cleanTypeWeights[k] = n;
    }
    const cleanLevelWeights = {};
    for (const [k, v] of Object.entries(wl)) {
      const n = Number(v);
      if (Number.isFinite(n)) cleanLevelWeights[k] = n;
    }
    const cleanRarityWeights = {};
    for (const [k, v] of Object.entries(wr)) {
      const n = Number(v);
      if (Number.isFinite(n)) cleanRarityWeights[k] = n;
    }
    return {
      types:    new Set(Array.isArray(obj.types)    ? obj.types : []),
      levels:   new Set(Array.isArray(obj.levels)   ? obj.levels.map(Number) : []),
      rarities: new Set(Array.isArray(obj.rarities) ? obj.rarities : []),
      weights: {
        types:    cleanTypeWeights,
        levels:   cleanLevelWeights,
        rarities: cleanRarityWeights,
      },
    };
  } catch {
    return null;
  }
}

export const saveFilters = debounce((filters) => {
  if (!filters) return;
  safeWrite(
    KEYS.filters,
    JSON.stringify({
      types:    [...(filters.types    ?? [])],
      levels:   [...(filters.levels   ?? [])],
      rarities: [...(filters.rarities ?? [])],
      weights: {
        types:    { ...(filters.weights?.types    ?? {}) },
        levels:   { ...(filters.weights?.levels   ?? {}) },
        rarities: { ...(filters.weights?.rarities ?? {}) },
      },
    }),
  );
}, 200);

// ---- Query ----

export function loadQuery() {
  return safeRead(KEYS.query) ?? "";
}

export const saveQuery = debounce((q) => {
  if (typeof q !== "string") return;
  if (!q) safeWrite(KEYS.query, null);
  else safeWrite(KEYS.query, q);
}, 200);

// ---- Picks (Map<featId, {class?: slug, or?: slug}>) ----
// User's resolution choices for multi-class / requires.any feats. Tied to
// the parent feat — removing the feat clears its picks. Walker reads them
// during DFS to know which path to follow.
export function loadPicks() {
  const raw = safeRead(KEYS.picks);
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return new Map();
    const out = new Map();
    for (const [featId, value] of Object.entries(obj)) {
      if (!value || typeof value !== "object") continue;
      const entry = {};
      if (typeof value.class === "string" && value.class) entry.class = value.class;
      if (typeof value.or === "string" && value.or) entry.or = value.or;
      if (typeof value.heritage === "string" && value.heritage) entry.heritage = value.heritage;
      // Foundry ChoiceSet resolutions: { [choiceId]: value } map per feat.
      if (value.choiceSets && typeof value.choiceSets === "object") {
        const cs = {};
        for (const [k, v] of Object.entries(value.choiceSets)) {
          if (typeof v === "string" && v) cs[k] = v;
        }
        if (Object.keys(cs).length > 0) entry.choiceSets = cs;
      }
      if (Object.keys(entry).length > 0) out.set(featId, entry);
    }
    return out;
  } catch {
    return new Map();
  }
}

export const savePicks = debounce((picks) => {
  if (!(picks instanceof Map)) return;
  const obj = {};
  for (const [featId, value] of picks) {
    if (!value) continue;
    const entry = {};
    if (value.class) entry.class = value.class;
    if (value.or) entry.or = value.or;
    if (value.heritage) entry.heritage = value.heritage;
    if (value.choiceSets && typeof value.choiceSets === "object") {
      const cs = {};
      for (const [k, v] of Object.entries(value.choiceSets)) {
        if (typeof v === "string" && v) cs[k] = v;
      }
      if (Object.keys(cs).length > 0) entry.choiceSets = cs;
    }
    if (Object.keys(entry).length > 0) obj[featId] = entry;
  }
  safeWrite(KEYS.picks, JSON.stringify(obj));
}, 200);
