// Load + freeze + index feats.json + class-features.json. Called once at boot.
//
// Two files, intentionally separate:
//   - feats.<hash>.json         — rollable, share-codable, indexed by position.
//   - class-features.<hash>.json — auto-applied "Free Feats" pulled in by chain.
// Class features live in `byId` (so prereq lookups resolve uniformly) and in
// `classFeaturesById` (for the Free Feats UI), but they are NOT in the
// canonical `feats` array — share-code indices stay stable.

const TYPE_ORDER = ["Class", "Ancestry", "Heritage", "Archetype", "General", "Skill", "Boon", "Curse", "Miscellaneous", "Mythic"];

export async function loadFeats() {
  const node = document.getElementById("feats-data");
  if (!node) throw new Error("Missing <script id=feats-data> in index.html");
  const src = node.dataset.src;
  if (!src) throw new Error("feats-data <script> missing data-src");

  const res = await fetch(src);
  if (!res.ok) throw new Error(`Failed to load ${src}: HTTP ${res.status}`);
  const arr = await res.json();

  // Class features are optional — older index.html builds may not have
  // emitted the second script tag yet. Fail open (empty array) so the app
  // still boots without them.
  const cfNode = document.getElementById("class-features-data");
  let classFeaturesArr = [];
  if (cfNode && cfNode.dataset.src) {
    try {
      const cfRes = await fetch(cfNode.dataset.src);
      if (cfRes.ok) classFeaturesArr = await cfRes.json();
      else console.warn(`class-features fetch failed: HTTP ${cfRes.status}`);
    } catch (err) {
      console.warn("class-features load failed:", err);
    }
  }

  // Ancestries (also optional, same pattern). Walker auto-pulls the matching
  // root when an Ancestry-trait feat lands in build.
  const ancNode = document.getElementById("ancestries-data");
  let ancestriesArr = [];
  if (ancNode && ancNode.dataset.src) {
    try {
      const ancRes = await fetch(ancNode.dataset.src);
      if (ancRes.ok) ancestriesArr = await ancRes.json();
      else console.warn(`ancestries fetch failed: HTTP ${ancRes.status}`);
    } catch (err) {
      console.warn("ancestries load failed:", err);
    }
  }

  // Heritages (also optional, same pattern). Includes both ancestry-specific
  // and versatile heritages. Walker pulls the parent ancestry when a
  // non-versatile heritage lands in build.
  const hNode = document.getElementById("heritages-data");
  let heritagesArr = [];
  if (hNode && hNode.dataset.src) {
    try {
      const hRes = await fetch(hNode.dataset.src);
      if (hRes.ok) heritagesArr = await hRes.json();
      else console.warn(`heritages fetch failed: HTTP ${hRes.status}`);
    } catch (err) {
      console.warn("heritages load failed:", err);
    }
  }

  // i18n subset for Foundry ChoiceSet prompts and labels. Optional — runtime
  // falls back to a heuristic strip-and-titlecase when keys are missing.
  const i18nNode = document.getElementById("i18n-data");
  let i18nObj = {};
  if (i18nNode && i18nNode.dataset.src) {
    try {
      const i18nRes = await fetch(i18nNode.dataset.src);
      if (i18nRes.ok) i18nObj = await i18nRes.json();
      else console.warn(`i18n fetch failed: HTTP ${i18nRes.status}`);
    } catch (err) {
      console.warn("i18n load failed:", err);
    }
  }

  return buildIndices(arr, classFeaturesArr, ancestriesArr, heritagesArr, i18nObj);
}

// Resolve a Foundry i18n key (e.g. "PF2E.Terrain.Aquatic") to a string.
// Looks up the shipped subset first; falls back to a heuristic that takes
// the last dotted segment and Title-Cases it. Pass-through for non-keys.
export function makeTranslate(i18nObj) {
  const map = i18nObj && typeof i18nObj === "object" ? i18nObj : {};
  return function translate(key) {
    if (!key || typeof key !== "string") return "";
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    // Strings that don't look like dotted i18n keys pass through verbatim
    // (e.g. an inline label that was already a literal in Foundry data).
    if (!/^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(key)) return key;
    const tail = key.split(".").pop() ?? key;
    return tail.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
  };
}

function buildIndices(arr, classFeaturesArr, ancestriesArr, heritagesArr, i18nObj) {
  const feats = Object.freeze(arr.map(Object.freeze));
  const classFeatures = Object.freeze(classFeaturesArr.map(Object.freeze));
  const ancestries = Object.freeze((ancestriesArr || []).map(Object.freeze));
  const heritages = Object.freeze((heritagesArr || []).map(Object.freeze));
  const i18n = Object.freeze(i18nObj || {});
  const translate = makeTranslate(i18n);

  const byId = new Map();
  const indexOfId = new Map();
  const byTypeLevel = new Map(); // "Type|Level" -> id[]
  const byType = new Map(); // Type -> id[]
  const byClass = new Map(); // ClassName -> id[]
  const classFeaturesById = new Map();
  const ancestriesById = new Map();
  const heritagesById = new Map();
  // Lowercase ancestry trait → ancestry root id. Walker uses this to
  // auto-pull "Halfling" when picking a feat with `halfling` trait.
  const ancestryByTrait = new Map();
  // Lowercase versatile-heritage trait → heritage id. Walker uses this
  // to auto-pull "Naari" when picking a feat with the `naari` trait
  // (Heat Wave, etc.). Ancestry-bound heritages typically have empty
  // trait lists; this index ends up containing only versatile heritages
  // that tag themselves with a self-named trait.
  const heritageByTrait = new Map();

  // Indexable feats first — these own the canonical positions.
  feats.forEach((f, i) => {
    byId.set(f.id, f);
    indexOfId.set(f.id, i);

    push(byType, f.type, f.id);
    push(byTypeLevel, `${f.type}|${f.level}`, f.id);
    if (f.class) push(byClass, f.class, f.id);
  });

  // Class features layered on top. Slug collisions were dropped at build
  // time, so an additional `byId.has` check here is just defensive.
  for (const cf of classFeatures) {
    if (byId.has(cf.id)) continue;
    byId.set(cf.id, cf);
    classFeaturesById.set(cf.id, cf);
  }

  // Heritages layered on top — both ancestry-specific (Gutsy Halfling)
  // and versatile (Naari, Sylph, Aiuvarin, …). Walker auto-pulls the
  // parent ancestry when a non-versatile heritage lands in build.
  for (const h of heritages) {
    if (byId.has(h.id)) continue;
    byId.set(h.id, h);
    heritagesById.set(h.id, h);
    push(byType, h.type, h.id);
    if (h.class) push(byClass, h.class, h.id);
    // Map every versatile heritage's slug to itself so a feat carrying
    // that trait can resolve back. Foundry feats use the heritage slug
    // as their access trait (e.g. Heat Wave has trait `naari`,
    // Bloodsoaked Dash has trait `hungerseed`) — even when the heritage
    // record's own self-trait differs (Hungerseed's traits is `["oni"]`).
    if (h.isVersatile) heritageByTrait.set(h.id, h.id);
  }

  // Ancestry roots layered on top. Slug collisions dropped at build time;
  // the byId.has guard here is defensive against future slug churn.
  for (const a of ancestries) {
    if (byId.has(a.id)) continue;
    byId.set(a.id, a);
    ancestriesById.set(a.id, a);
    // Foundry ancestry traits are lowercase slugs (e.g. ["halfling",
    // "humanoid"]). Map ANY trait that matches the root's own slug.
    // Most ancestries are tagged with a single self-named trait.
    for (const t of a.traits ?? []) {
      const lc = String(t).toLowerCase();
      if (lc === a.id && !ancestryByTrait.has(lc)) {
        ancestryByTrait.set(lc, a.id);
      }
    }
    // Defensive: if the self-named trait wasn't in the trait list, still
    // allow lookup by slug (so a feat with trait "halfling" finds the
    // halfling root even if the ancestry's own traits[] omits it).
    if (!ancestryByTrait.has(a.id)) ancestryByTrait.set(a.id, a.id);
  }

  // Chain DAG: parent (immediate prereq) → children, plus root set. Only
  // `requires.all` edges form chains — those are the *required* prereqs
  // that gate a downstream feat. `requires.any` (OR group) means
  // "alternative prereqs" — it shouldn't make the feat a chain child of
  // any one of them, otherwise multi-OR feats like Stunning Appearance
  // get hidden behind chain pills instead of rendering standalone.
  const parents = new Map(); // id -> Set<parentId>
  const children = new Map(); // id -> Set<childId>
  const roots = new Set(); // ids with no resolved feat-prereq

  for (const item of [...feats, ...classFeatures]) {
    const reqs = item.requires?.all ?? [];
    if (!reqs.length) {
      roots.add(item.id);
      continue;
    }
    const parentSet = new Set(reqs);
    parents.set(item.id, parentSet);
    for (const p of parentSet) {
      if (!children.has(p)) children.set(p, new Set());
      children.get(p).add(item.id);
    }
  }

  return Object.freeze({
    feats,
    byId,
    indexOfId,
    byType,
    byTypeLevel,
    byClass,
    classFeaturesById,
    ancestriesById,
    heritagesById,
    ancestryByTrait,
    heritageByTrait,
    i18n,
    translate,
    chains: Object.freeze({ parents, children, roots }),
    typeOrder: TYPE_ORDER,
  });
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
