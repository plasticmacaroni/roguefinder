// Pure selector functions. No DOM, no side effects.

import { fuzzyMatch, substringMatch } from "./util/fuzzy.js";

// --- Trait/type filter mapping ---
// Each filter "type" maps to a predicate. Matches AoN-ish intuition where
// "General" includes any feat with the general trait (skill feats included),
// rather than the Foundry directory grouping.

const FILTER_PREDICATES = {
  Class:     (f) => f.type === "Class",
  Ancestry:  (f) => f.type === "Ancestry" || f.traits.includes("ancestry"),
  Archetype: (f) => f.type === "Archetype" || f.traits.includes("archetype"),
  Skill:     (f) => f.traits.includes("skill") || f.type === "Skill",
  General:   (f) => f.traits.includes("general") || f.type === "General",
  Boon:      (f) => f.type === "Boon",
  Curse:     (f) => f.type === "Curse",
  Mythic:    (f) => f.type === "Mythic" || f.traits.includes("mythic"),
  Miscellaneous: (f) => f.type === "Miscellaneous",
};

export const FILTER_TYPES = Object.keys(FILTER_PREDICATES);

export function matchesTypeFilter(feat, types) {
  if (!types || types.size === 0) return true; // no filter = all
  for (const t of types) {
    const pred = FILTER_PREDICATES[t];
    if (pred && pred(feat)) return true;
  }
  return false;
}

export function matchesLevelFilter(feat, levels) {
  if (!levels || levels.size === 0) return true;
  // Boons / Curses are level-less by design (deity-granted, all level 0).
  // Don't gate them on the level filter — that would hide the section any
  // time the user picks a non-zero level.
  if (feat.type === "Boon" || feat.type === "Curse") return true;
  return levels.has(feat.level);
}

export function matchesRarityFilter(feat, rarities) {
  if (!rarities || rarities.size === 0) return true;
  return rarities.has(feat.rarity);
}

// --- Chain logic ---

// Wildcard helpers: a build has "any X-class feat" if any owned feat has X
// as its class field OR as a trait (class names appear as traits).
function buildHasClassFeat(build, byId, className) {
  if (!className) return false;
  const lower = className.toLowerCase();
  for (const id of build) {
    const f = byId.get(id);
    if (!f) continue;
    if (f.class && f.class.toLowerCase() === lower) return true;
    if (f.traits.some((t) => t.toLowerCase() === lower)) return true;
  }
  return false;
}

function buildHasTraitFeat(build, byId, trait) {
  if (!trait) return false;
  const lower = trait.toLowerCase();
  for (const id of build) {
    const f = byId.get(id);
    if (!f) continue;
    if (f.traits.some((t) => t.toLowerCase() === lower)) return true;
  }
  return false;
}

// Returns true if the feat's prereqs are satisfied by the current build.
// Empty `requires` → always satisfied (the feat is a chain root or has only
// non-feat prereqs which are out of scope per project decision).
//
// Classfeature deps are SOFT: any prereq slug whose target is a class
// feature is treated as already-satisfied, even if it isn't in `build`.
// This avoids a chicken-and-egg with the lazy auto-pull — the user can pick
// a feat that names a classfeature prereq and the classfeature will
// materialize in `autoBuild` only AFTER the feat lands in the build.
function isClassFeatureId(id, byId) {
  return byId?.get?.(id)?.type === "ClassFeature";
}

export function requirementsSatisfied(feat, build, byId) {
  const r = feat.requires;
  if (!r) return true;

  // ALL: every required slug must be in build (or be a soft classfeature)
  if (r.all && r.all.length) {
    for (const id of r.all) {
      if (build.has(id)) continue;
      if (isClassFeatureId(id, byId)) continue;
      return false;
    }
  }
  // ANY: at least one of the OR group must be in build (or be a soft classfeature)
  if (r.any && r.any.length) {
    let ok = false;
    for (const id of r.any) {
      if (build.has(id) || isClassFeatureId(id, byId)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  // anyClassFeat: build must contain at least one feat of that class
  if (r.anyClassFeat) {
    if (!buildHasClassFeat(build, byId, r.anyClassFeat)) return false;
  }
  // anyTrait: build must contain at least one feat with that trait
  if (r.anyTrait) {
    if (!buildHasTraitFeat(build, byId, r.anyTrait)) return false;
  }
  return true;
}

export function isLocked(feat, build, byId) {
  return !requirementsSatisfied(feat, build, byId);
}

// --- Selectors ---

// The roller pool: feats that pass filters, are not already owned, and
// whose prereqs are satisfied by the current build (plus the auto-applied
// classfeatures, when caller passes them).
export function rollablePool(filters, build, data, autoBuild = null) {
  const owned = autoBuild && autoBuild.size > 0
    ? new Set([...build, ...autoBuild.keys()])
    : build;
  const out = [];
  for (const f of data.feats) {
    if (build.has(f.id)) continue;
    if (!matchesTypeFilter(f, filters.types)) continue;
    if (!matchesLevelFilter(f, filters.levels)) continue;
    if (!matchesRarityFilter(f, filters.rarities)) continue;
    if (!requirementsSatisfied(f, owned, data.byId)) continue;
    out.push(f);
  }
  return out;
}

// The grid view: feats that pass filters AND search query. Locked feats
// are still included (rendered dimmed via .is-locked class).
export function visibleGrid(filters, query, data) {
  const out = [];
  const q = (query ?? "").trim();
  const useSubstring = q.length > 0 && q.length <= 3; // short queries: substring (stricter)
  for (const f of data.feats) {
    if (!matchesTypeFilter(f, filters.types)) continue;
    if (!matchesLevelFilter(f, filters.levels)) continue;
    if (!matchesRarityFilter(f, filters.rarities)) continue;
    if (q) {
      const ok = useSubstring ? substringMatch(f.name, q) : fuzzyMatch(f.name, q);
      if (!ok) continue;
    }
    out.push(f);
  }
  return out;
}

// Cheaper variant for large grids: returns a Set of visible IDs.
export function visibleIdSet(filters, query, data) {
  const set = new Set();
  for (const f of visibleGrid(filters, query, data)) set.add(f.id);
  return set;
}

// --- Weighted sampling (FREQ-06) ---
//
// Each feat in the pool is assigned a weight = type-share × level-share where
// each share is a sum of explicit per-chip weights for chips that claim the
// feat (chip "claims" feat = its predicate matches OR its level matches). A
// chip that's "on" without an explicit weight contributes a default of 1.
// When no chips are selected in a dimension, that dimension contributes 1
// (no bias).

const DEFAULT_WEIGHT = 1;

export function featSampleWeight(feat, filters) {
  let typeShare = DEFAULT_WEIGHT;
  if (filters.types && filters.types.size > 0) {
    typeShare = 0;
    const wt = filters.weights?.types ?? {};
    for (const t of filters.types) {
      const pred = FILTER_PREDICATES[t];
      if (pred && pred(feat)) {
        typeShare += t in wt ? Number(wt[t]) : DEFAULT_WEIGHT;
      }
    }
  }
  let levelShare = DEFAULT_WEIGHT;
  if (filters.levels && filters.levels.size > 0) {
    const wl = filters.weights?.levels ?? {};
    if (filters.levels.has(feat.level)) {
      levelShare = String(feat.level) in wl ? Number(wl[feat.level]) : DEFAULT_WEIGHT;
    } else {
      levelShare = 0;
    }
  }
  let rarityShare = DEFAULT_WEIGHT;
  if (filters.rarities && filters.rarities.size > 0) {
    const wr = filters.weights?.rarities ?? {};
    if (filters.rarities.has(feat.rarity)) {
      rarityShare = feat.rarity in wr ? Number(wr[feat.rarity]) : DEFAULT_WEIGHT;
    } else {
      rarityShare = 0;
    }
  }
  // Negative or NaN weights are treated as 0 (drop from sampler).
  if (!Number.isFinite(typeShare)   || typeShare   < 0) typeShare   = 0;
  if (!Number.isFinite(levelShare)  || levelShare  < 0) levelShare  = 0;
  if (!Number.isFinite(rarityShare) || rarityShare < 0) rarityShare = 0;
  return typeShare * levelShare * rarityShare;
}

// Returns true if the user has set ANY explicit non-default weight, in which
// case the weighted sampler should be used. Otherwise uniform is fine and
// faster.
export function hasActiveWeights(filters) {
  const wt = filters.weights?.types;
  const wl = filters.weights?.levels;
  const wr = filters.weights?.rarities;
  return Boolean(
    (wt && Object.keys(wt).length > 0) ||
    (wl && Object.keys(wl).length > 0) ||
    (wr && Object.keys(wr).length > 0),
  );
}

// Pick `count` distinct feats from `pool` weighted by featSampleWeight. Falls
// back to uniform within the remaining items if the running total ever
// reaches zero (e.g., user weighted everything to 0).
export function sampleWeightedDistinct(pool, count, filters) {
  const n = Math.min(count, pool.length);
  if (n === 0) return [];
  const weights = pool.map((f) => featSampleWeight(f, filters));
  const taken = new Uint8Array(pool.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (let j = 0; j < pool.length; j++) {
      if (taken[j]) continue;
      total += weights[j];
    }
    if (total > 0) {
      let r = Math.random() * total;
      for (let j = 0; j < pool.length; j++) {
        if (taken[j]) continue;
        r -= weights[j];
        if (r <= 0) {
          taken[j] = 1;
          out.push(pool[j]);
          break;
        }
      }
    } else {
      // All remaining weights are zero — fall back to uniform.
      const remaining = [];
      for (let j = 0; j < pool.length; j++) if (!taken[j]) remaining.push(j);
      const idx = remaining[Math.floor(Math.random() * remaining.length)];
      taken[idx] = 1;
      out.push(pool[idx]);
    }
  }
  return out;
}
