import { createStore } from "./store.js";
import { requirementsSatisfied } from "./selectors.js";
import { loadBuild, loadFilters, loadQuery, loadPicks } from "./persist.js";

// Boot from localStorage. Defaults: empty build, empty filters (= show
// everything), empty query, empty picks.
const persistedBuild = loadBuild();
const persistedFilters = loadFilters();
const persistedQuery = loadQuery();
const persistedPicks = loadPicks();

export const { store, subscribe, subscribeAll } = createStore({
  build: persistedBuild,
  // picks: Map<featId, {class?: slug, or?: slug}>. Resolution choices for
  // multi-class and requires.any feats. Tied to parent feat — removed when
  // feat is removed. Walker reads during DFS. Persisted; share-codes don't
  // carry picks (receivers re-resolve via cascade modal on load).
  picks: persistedPicks,
  // autoBuild is derived from build; we leave it empty at boot and fill it
  // in once setStateData() runs (so byId is available for the DAG walk).
  // Keyed Map<id, bucket>. Bucket label drives Free Feats grouping and is
  // computed from walker provenance (see computeAutoBuildFor). Map iteration
  // yields [id, bucket] pairs — consumers that want just ids must use
  // .keys() / .has() / .size; do NOT spread the Map directly.
  autoBuild: new Map(),
  expanded: null,
  openType: null,
  filters: persistedFilters ?? {
    types:    new Set(),
    levels:   new Set(),
    rarities: new Set(),
    weights:  { types: {}, levels: {}, rarities: {} },
  },
  query: persistedQuery ?? "",
});

// Defensive backfill for legacy persisted filter payloads that pre-date the
// weights / rarities additions.
{
  const f = store.filters;
  let dirty = false;
  let next = { ...f };
  if (!next.rarities) { next.rarities = new Set(); dirty = true; }
  if (!next.weights)  { next.weights  = { types: {}, levels: {}, rarities: {} }; dirty = true; }
  else if (!next.weights.rarities) {
    next.weights = { ...next.weights, rarities: {} };
    dirty = true;
  }
  if (dirty) store.filters = next;
}

// Build helpers need access to byId for cascade-orphan logic. main.js calls
// setStateData(data) once after loadFeats() resolves.
let _data = null;
export function setStateData(data) {
  _data = data;
  // Now that data is available we can derive autoBuild from the (possibly
  // already-loaded) persisted build.
  recomputeAutoBuild();
}

// Accessor for the loaded data (byId, translate, etc.). Returns null
// before setStateData runs. Used by render helpers (pill.js, build-summary)
// that need translate without import-cycling through detail.js.
export function getData() {
  return _data;
}

// --- autoBuild: lazy "Free Feats" -----------------------------------------
//
// Walks each id in `build` through the prereq DAG and collects every
// reachable dep — both classfeatures (e.g. unmapped Champion orders that
// stayed as raw classfeature refs) AND regular feats (e.g. Magus Dedication,
// pulled in transitively by feats whose classfeature deps were rewritten to
// dedications during the build's Phase-1+2 pass). Anything the user has
// already explicitly chosen is skipped. Cycle-safe via the `out.has` check.

// PF2e class names — the trait→dedication shortcut keys off this set.
// Exported so card surfaces (detail modal, bloom cards) can detect when a
// feat needs a class picker (multi-class trait).
export const KNOWN_CLASSES = new Set([
  "alchemist","animist","barbarian","bard","champion","cleric",
  "druid","exemplar","fighter","gunslinger","inventor","investigator",
  "kineticist","magus","monk","oracle","psychic","ranger","rogue",
  "sorcerer","summoner","swashbuckler","thaumaturge","witch","wizard",
]);

// Title-cased dedication name from a slug like "hellknight-armiger-dedication"
// → "Hellknight Armiger". Returns null when slug doesn't match the suffix.
function trimmedDedicationName(slug) {
  if (typeof slug !== "string") return null;
  const m = /^(.+)-dedication$/.exec(slug);
  if (!m) return null;
  return m[1]
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Pick ONE canonical bucket label for a connected group of feat ids
// (a build seed + everything the walker reached from it).
//   1. First non-null `feat.class` in the group (source first → DFS order).
//   2. Else the SHORTEST-prefix `<prefix>-dedication` slug in the group,
//      Title-Cased. Post-Remaster a shorter prefix is the canonical name —
//      e.g. group {hellknight-armiger-dedication, hellknight-dedication} →
//      "hellknight" wins → "Hellknight". Both items bucket together.
//   3. Else null → rendered as "Other".
function deriveCanonicalBucket(idsInOrder, byId) {
  for (const id of idsInOrder) {
    const c = byId.get(id)?.class;
    if (c) return c;
  }
  let bestPrefix = null;
  for (const id of idsInOrder) {
    const m = /^(.+)-dedication$/.exec(id);
    if (!m) continue;
    if (bestPrefix === null || m[1].length < bestPrefix.length) {
      bestPrefix = m[1];
    }
  }
  return bestPrefix ? trimmedDedicationName(`${bestPrefix}-dedication`) : null;
}

// Exported so card surfaces (detail modal, bloom cards) can compute a
// hypothetical autoBuild for a candidate feat without mutating the store
// (e.g. "what free feats would I pick up if I added Versatile Spellstrike +
// the Magus path?"). Pass any Set of feat ids; the walker DFS-traverses it.
//
// Returns Map<id, bucket> where bucket is the Free Feats grouping label.
// Two-pass:
//   Pass 1 — DFS collects sourceOf: Map<id, sourceId> (first-touch wins).
//   Pass 2 — group by source, derive canonical bucket per group.
export function computeAutoBuildFor(
  build,
  picks = store.picks ?? new Map(),
  byId = _data?.byId,
) {
  const out = new Map();
  if (!byId) return out;
  const sourceOf = new Map();
  const stack = [];
  for (const seed of build) {
    sourceOf.set(seed, seed);
    stack.push([seed, seed]);
  }
  const tryAdd = (refId, sourceId) => {
    if (!refId) return;
    const ref = byId.get(refId);
    if (!ref) return;
    if (build.has(refId)) return;
    if (sourceOf.has(refId)) return; // first-touch wins
    sourceOf.set(refId, sourceId);
    stack.push([refId, sourceId]);
  };
  while (stack.length) {
    const [id, sourceId] = stack.pop();
    const item = byId.get(id);
    if (!item) continue;
    // (z) user picks — multi-class / requires.any / Foundry-ChoiceSet
    // resolutions tied to this feat. Each chosen slug is pulled into
    // autoBuild as if it were an extra requires-all. Walker never auto-
    // pulls from those branches otherwise; unresolved picks surface via
    // the cascade modal at boot / post-add.
    const featPicks = picks.get(id);
    if (featPicks) {
      if (featPicks.class) tryAdd(featPicks.class, sourceId);
      if (featPicks.or) tryAdd(featPicks.or, sourceId);
      // ChoiceSet resolutions: only feat-yielding values traverse. Tag
      // values (skill, terrain, weapon-type) persist for display but
      // don't pull a chain.
      if (featPicks.choiceSets && item.choices) {
        for (const choice of item.choices) {
          const value = featPicks.choiceSets[choice.id];
          if (!value) continue;
          const opt = choice.options?.find((o) => o.value === value);
          if (opt && opt.yieldsFeat) tryAdd(value, sourceId);
        }
      }
    }
    // (a) literal prereq slugs. `requires.all` is mandatory; `requires.any`
    // is user choice — recorded in `picks[id].or` and processed above.
    for (const r of item.requires?.all ?? []) tryAdd(r, sourceId);
    // (b) Foundry GrantItem grants
    for (const g of item.grants ?? []) tryAdd(g, sourceId);
    // (c) class-trait → dedication. When a classfeature lands in the walk,
    // also auto-pull its archetype dedication so the chain reads end-to-end.
    // Single class trait → auto-pull. Multi class trait → defer to user
    // pick on the card (chosen <class>-dedication slug self-encodes in
    // build, same mechanism as requires.any picker).
    if (item.type === "ClassFeature") {
      const cfClassTraits = (item.traits ?? [])
        .map((t) => String(t).toLowerCase())
        .filter((t) => KNOWN_CLASSES.has(t));
      if (cfClassTraits.length === 1) {
        tryAdd(`${cfClassTraits[0]}-dedication`, sourceId);
      }
      // (d) hand-curated dedication-fallback for classfeatures that don't
      // carry a class trait (Hellknight orders, etc.). Source of truth:
      // tools/classfeature-overrides.json baked into the class-features file.
      for (const d of item.dedicationFallback ?? []) tryAdd(d, sourceId);
    }
    // (e) class-feat → dedication. Priority:
    //   1. feat.class (canonical class field, set by normalize for class/<x>/
    //      feats and via `liftClassFromDedicationSlug` for `<class>-dedication`
    //      archetype feats).
    //   2. else single class trait on a Class-type feat (defensive — covers
    //      cases where normalize-time lift didn't catch).
    //   3. else (2+ class traits) → SKIP. The card surfaces a class picker;
    //      the user's pick adds the chosen <class>-dedication directly to
    //      build, so the walker reaches it on the next pass via branch (a).
    if (item.class) {
      const lc = String(item.class).toLowerCase();
      if (KNOWN_CLASSES.has(lc)) tryAdd(`${lc}-dedication`, sourceId);
    } else if (item.type === "Class") {
      const classTraits = (item.traits ?? [])
        .map((t) => String(t).toLowerCase())
        .filter((t) => KNOWN_CLASSES.has(t));
      if (classTraits.length === 1) {
        tryAdd(`${classTraits[0]}-dedication`, sourceId);
      }
    }
    // (f) ancestry trait → ancestry root. When an Ancestry-typed feat lands
    // in the walk and carries a known-ancestry trait, pull the matching
    // root (Halfling / Elf / etc.) so the user sees their lineage in
    // Free Feats. Single-trait → auto-pull. Multi-trait deferred (future
    // ancestry picker; rare in practice). Skip ancestry roots themselves
    // to avoid trivial self-recursion.
    if (item.type === "Ancestry" && !item.isAncestryRoot) {
      const ancestryTraits = [];
      for (const t of item.traits ?? []) {
        const lc = String(t).toLowerCase();
        const rootId = byId.get(lc) ? lc : null;
        if (rootId && byId.get(rootId)?.isAncestryRoot) ancestryTraits.push(rootId);
      }
      if (ancestryTraits.length === 1) {
        tryAdd(ancestryTraits[0], sourceId);
      }
    }
  }

  // Pass 2: bucket per source-component.
  const bySource = new Map();
  for (const [id, source] of sourceOf) {
    if (build.has(id)) continue; // build seeds are not in autoBuild
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(id);
  }
  for (const [source, items] of bySource) {
    // Source listed first so its `feat.class` takes priority.
    const allInGroup = [source, ...items];
    const bucket = deriveCanonicalBucket(allInGroup, byId);
    for (const id of items) out.set(id, bucket);
  }
  return out;
}

function recomputeAutoBuild() {
  const next = computeAutoBuildFor(store.build);
  // Equality short-circuit — avoid spurious subscriber fan-out when nothing
  // actually changed. Compare keys + values (bucket label can shift when
  // the user adds a build feat that promotes a shared canonical bucket).
  const cur = store.autoBuild ?? new Map();
  if (cur.size === next.size) {
    let same = true;
    for (const [id, bucket] of next) {
      if (!cur.has(id) || cur.get(id) !== bucket) { same = false; break; }
    }
    if (same) return;
  }
  store.autoBuild = next;
}

// Returns a fresh Set of "owned" ids = build ∪ autoBuild keys. This is
// what selectors pass to requirementsSatisfied / isLocked. autoBuild is
// a Map keyed by id, so we iterate `.keys()` (Map iteration yields pairs).
export function ownedSet(build = store.build, autoBuild = store.autoBuild) {
  const out = new Set(build);
  if (autoBuild) {
    const ids = autoBuild instanceof Map ? autoBuild.keys() : autoBuild;
    for (const id of ids) out.add(id);
  }
  return out;
}

// Subscribe early so any build/picks mutation flows into autoBuild before
// other subscribers fire. createStore notifies in insertion order.
subscribe("build", () => recomputeAutoBuild());
subscribe("picks", () => recomputeAutoBuild());

// --- picks helpers (multi-class + requires.any resolutions per build feat) ---

// Set or clear a single resolution slot.
//   setPick(featId, "class", slug)  → top-level class pick
//   setPick(featId, "or",    slug)  → top-level OR-prereq pick
//   setPick(featId, "choiceSet", { id, value })  → nested ChoiceSet pick
// Pass slug / value falsy to clear that slot. Replaces whole picks Map.
export function setPick(featId, kind, slugOrPayload) {
  if (!featId) return;
  const next = new Map(store.picks);
  const cur = next.get(featId) ?? {};
  const updated = { ...cur };
  if (kind === "class" || kind === "or") {
    if (slugOrPayload) updated[kind] = slugOrPayload;
    else delete updated[kind];
  } else if (kind === "choiceSet") {
    const { id, value } = slugOrPayload ?? {};
    if (!id) return;
    const cs = { ...(updated.choiceSets ?? {}) };
    if (value) cs[id] = value;
    else delete cs[id];
    if (Object.keys(cs).length === 0) delete updated.choiceSets;
    else updated.choiceSets = cs;
  } else {
    return;
  }
  if (Object.keys(updated).length === 0) next.delete(featId);
  else next.set(featId, updated);
  store.picks = next;
}

// Drop the picks entry for this feat (called on feat removal).
export function clearPicksFor(featId) {
  if (!store.picks.has(featId)) return;
  const next = new Map(store.picks);
  next.delete(featId);
  store.picks = next;
}

// --- mutation helpers (encapsulate the "replace whole value" discipline) ---

// Returns the list of feat IDs that were *also* removed as orphans (chain
// dependents whose prereqs are no longer satisfied). Empty when adding.
export function toggleBuild(id) {
  if (store.build.has(id)) {
    return removeFromBuild(id);
  }
  const next = new Set(store.build);
  next.add(id);
  store.build = next;
  return [];
}

export function addToBuild(id) {
  if (store.build.has(id)) return [];
  const next = new Set(store.build);
  next.add(id);
  store.build = next;
  return [];
}

// Remove a feat AND any dependents that lose their prereqs as a result.
// Iterates to fixed point so multi-level chains (Parry → Riposte → Dance)
// cascade correctly. Returns the orphan IDs (NOT including the originally
// removed feat).
export function removeFromBuild(id) {
  if (!store.build.has(id)) return [];
  const next = new Set(store.build);
  next.delete(id);
  const orphans = [];
  // Picks for the removed feat (and any cascade-orphans) drop too —
  // they're tied to the parent. Walker reads picks during DFS, so
  // clearing first ensures the cascade-orphan check below sees the
  // post-removal autoBuild.
  let nextPicks = store.picks.has(id) ? new Map(store.picks) : store.picks;
  if (nextPicks !== store.picks) nextPicks.delete(id);
  if (_data) {
    let changed = true;
    while (changed) {
      changed = false;
      // Recompute autoBuild against the current `next`+`nextPicks` so
      // removing a feat that was the sole reason a classfeature was
      // auto-applied also cascades any feats that depended on it.
      const auto = computeAutoBuildFor(next, nextPicks);
      const owned = new Set(next);
      for (const a of auto.keys()) owned.add(a);
      for (const fid of [...next]) {
        const f = _data.byId.get(fid);
        if (!f) continue;
        if (!requirementsSatisfied(f, owned, _data.byId)) {
          next.delete(fid);
          orphans.push(fid);
          if (nextPicks.has(fid)) {
            if (nextPicks === store.picks) nextPicks = new Map(store.picks);
            nextPicks.delete(fid);
          }
          changed = true;
        }
      }
    }
    // Drop picks for any feat no longer in build ∪ autoBuild. Without this,
    // a feat that was auto-pulled (Swashbuckler Dedication via Flamboyant
    // Cruelty) would keep its ChoiceSet picks (Athletics) lying around, and
    // re-adding the parent later would silently re-resolve the cascade with
    // the stale pick instead of prompting fresh.
    const finalAuto = computeAutoBuildFor(next, nextPicks);
    const finalOwned = new Set(next);
    for (const a of finalAuto.keys()) finalOwned.add(a);
    for (const fid of [...nextPicks.keys()]) {
      if (!finalOwned.has(fid)) {
        if (nextPicks === store.picks) nextPicks = new Map(store.picks);
        nextPicks.delete(fid);
      }
    }
  }
  // Mutate picks before build so the build subscribers see consistent
  // state when they recompute autoBuild from the new build value.
  if (nextPicks !== store.picks) store.picks = nextPicks;
  store.build = next;
  return orphans;
}

export function clearBuild() {
  // Wipe picks alongside build — same logic as removeFromBuild's stale-
  // pick sweep, just simpler since nothing remains owned.
  store.picks = new Map();
  store.build = new Set();
}

export function setExpanded(id) {
  store.expanded = id;
}

export function setQuery(q) {
  store.query = q ?? "";
}

export function toggleFilterType(t) {
  const next = new Set(store.filters.types);
  const wTypes = { ...(store.filters.weights?.types ?? {}) };
  if (next.has(t)) {
    next.delete(t);
    // FREQ-04: toggling off auto-clears any custom frequency.
    delete wTypes[t];
  } else {
    next.add(t);
  }
  store.filters = {
    ...store.filters,
    types: next,
    weights: { ...store.filters.weights, types: wTypes },
  };
}

export function toggleFilterLevel(n) {
  const next = new Set(store.filters.levels);
  const wLevels = { ...(store.filters.weights?.levels ?? {}) };
  if (next.has(n)) {
    next.delete(n);
    delete wLevels[n];
  } else {
    next.add(n);
  }
  store.filters = {
    ...store.filters,
    levels: next,
    weights: { ...store.filters.weights, levels: wLevels },
  };
}

export function setFilterTypes(set) {
  // Drop weights for any types that were removed.
  const kept = new Set(set);
  const oldW = store.filters.weights?.types ?? {};
  const wTypes = {};
  for (const k of Object.keys(oldW)) if (kept.has(k)) wTypes[k] = oldW[k];
  store.filters = {
    ...store.filters,
    types: kept,
    weights: { ...store.filters.weights, types: wTypes },
  };
}

export function setFilterLevels(set) {
  const kept = new Set(set);
  const oldW = store.filters.weights?.levels ?? {};
  const wLevels = {};
  for (const k of Object.keys(oldW)) if (kept.has(Number(k))) wLevels[k] = oldW[k];
  store.filters = {
    ...store.filters,
    levels: kept,
    weights: { ...store.filters.weights, levels: wLevels },
  };
}

export function toggleFilterRarity(r) {
  const next = new Set(store.filters.rarities);
  const wRar = { ...(store.filters.weights?.rarities ?? {}) };
  if (next.has(r)) {
    next.delete(r);
    delete wRar[r];
  } else {
    next.add(r);
  }
  store.filters = {
    ...store.filters,
    rarities: next,
    weights: { ...store.filters.weights, rarities: wRar },
  };
}

export function setFilterRarities(set) {
  const kept = new Set(set);
  const oldW = store.filters.weights?.rarities ?? {};
  const wRar = {};
  for (const k of Object.keys(oldW)) if (kept.has(k)) wRar[k] = oldW[k];
  store.filters = {
    ...store.filters,
    rarities: kept,
    weights: { ...store.filters.weights, rarities: wRar },
  };
}

export function clearFilters() {
  store.filters = {
    types:    new Set(),
    levels:   new Set(),
    rarities: new Set(),
    weights:  { types: {}, levels: {}, rarities: {} },
  };
}

// FREQ-03: setting a weight auto-toggles the chip on.
export function setTypeWeight(t, weight) {
  const types = new Set(store.filters.types);
  types.add(t);
  const wTypes = { ...(store.filters.weights?.types ?? {}), [t]: weight };
  store.filters = {
    ...store.filters,
    types,
    weights: { ...store.filters.weights, types: wTypes },
  };
}

export function clearTypeWeight(t) {
  const wTypes = { ...(store.filters.weights?.types ?? {}) };
  if (!(t in wTypes)) return;
  delete wTypes[t];
  store.filters = {
    ...store.filters,
    weights: { ...store.filters.weights, types: wTypes },
  };
}

export function setLevelWeight(n, weight) {
  const levels = new Set(store.filters.levels);
  levels.add(n);
  const wLevels = {
    ...(store.filters.weights?.levels ?? {}),
    [n]: weight,
  };
  store.filters = {
    ...store.filters,
    levels,
    weights: { ...store.filters.weights, levels: wLevels },
  };
}

export function clearLevelWeight(n) {
  const wLevels = { ...(store.filters.weights?.levels ?? {}) };
  if (!(n in wLevels)) return;
  delete wLevels[n];
  store.filters = {
    ...store.filters,
    weights: { ...store.filters.weights, levels: wLevels },
  };
}

export function setRarityWeight(r, weight) {
  const rarities = new Set(store.filters.rarities);
  rarities.add(r);
  const wRar = { ...(store.filters.weights?.rarities ?? {}), [r]: weight };
  store.filters = {
    ...store.filters,
    rarities,
    weights: { ...store.filters.weights, rarities: wRar },
  };
}

export function clearRarityWeight(r) {
  const wRar = { ...(store.filters.weights?.rarities ?? {}) };
  if (!(r in wRar)) return;
  delete wRar[r];
  store.filters = {
    ...store.filters,
    weights: { ...store.filters.weights, rarities: wRar },
  };
}

// Atomic bulk setter used by the frequency modal on Save. Single store
// mutation → one subscriber fan-out (filter UI repaint + persist write).
// Pass plain {key: number} objects; the helper deep-copies to avoid
// downstream aliasing.
export function setAllWeights({ types, levels, rarities }) {
  store.filters = {
    ...store.filters,
    weights: {
      types:    { ...(types    ?? {}) },
      levels:   { ...(levels   ?? {}) },
      rarities: { ...(rarities ?? {}) },
    },
  };
}
