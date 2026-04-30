import { el } from "./util/dom.js";
import { FILTER_TYPES } from "./selectors.js";
import {
  store,
  subscribe,
  toggleFilterType,
  toggleFilterLevel,
  toggleFilterRarity,
  setFilterLevels,
  setFilterTypes,
  setFilterRarities,
} from "./state.js";
import { openFreqModal } from "./freq-modal.js";

const LEVELS = Array.from({ length: 21 }, (_, i) => i); // 0..20
const RARITIES = ["common", "uncommon", "rare", "unique"];

function rarityLabel(r) {
  return r[0].toUpperCase() + r.slice(1);
}

export function renderFilters(parent) {
  const types = el(
    "section",
    { class: "filter-section filter-section--types", "aria-label": "Filter by feat type" },
    el(
      "header",
      { class: "filter-section__head" },
      el("h3", { class: "filter-section__title" }, "Types"),
      el(
        "button",
        {
          class: "filter-section__clear",
          type: "button",
          title: "Clear type filters (show all types)",
          onclick: () => setFilterTypes([]),
        },
        "Clear",
      ),
    ),
    el(
      "div",
      { class: "filter-section__chips" },
      ...FILTER_TYPES.map((t) => buildChipPair("types", t, t)),
    ),
  );

  const levels = el(
    "section",
    { class: "filter-section filter-section--levels", "aria-label": "Filter by feat level" },
    el(
      "header",
      { class: "filter-section__head" },
      el("h3", { class: "filter-section__title" }, "Levels"),
      el(
        "button",
        {
          class: "filter-section__clear",
          type: "button",
          title: "Show all levels",
          onclick: () => setFilterLevels([]),
        },
        "Clear",
      ),
    ),
    el(
      "div",
      { class: "filter-section__chips filter-section__chips--levels" },
      ...LEVELS.map((n) => buildChipPair("levels", n, String(n))),
    ),
  );

  const rarities = el(
    "section",
    { class: "filter-section filter-section--rarities", "aria-label": "Filter by rarity" },
    el(
      "header",
      { class: "filter-section__head" },
      el("h3", { class: "filter-section__title" }, "Rarities"),
      el(
        "button",
        {
          class: "filter-section__clear",
          type: "button",
          title: "Clear rarity filters (show all rarities)",
          onclick: () => setFilterRarities([]),
        },
        "Clear",
      ),
    ),
    el(
      "div",
      { class: "filter-section__chips filter-section__chips--rarities" },
      ...RARITIES.map((r) => buildChipPair("rarities", r, rarityLabel(r))),
    ),
  );

  const wrap = el(
    "div",
    { class: "filters", role: "region", "aria-label": "Filters" },
    types,
    levels,
    rarities,
  );
  parent.appendChild(wrap);

  // Sync UI to store on change.
  const sync = () => syncFilterUI(wrap);
  subscribe("filters", sync);
  sync();
}

// One chip + its sibling % button. The chip toggles selection; the % button
// opens the unified frequency modal (always opens the same modal — focus is
// scrolled to the row matching this chip).
function buildChipPair(dimension, key, label) {
  const chipClassFor = {
    types:    "type-check",
    levels:   "level-chip",
    rarities: "rarity-chip",
  };
  const datasetFor = {
    types:    { type:   String(key) },
    levels:   { level:  String(key) },
    rarities: { rarity: String(key) },
  };
  const onToggleFor = {
    types:    () => toggleFilterType(key),
    levels:   () => toggleFilterLevel(key),
    rarities: () => toggleFilterRarity(key),
  };
  const chip = el(
    "button",
    {
      class: chipClassFor[dimension],
      type: "button",
      dataset: datasetFor[dimension],
      "aria-pressed": "false",
      onclick: onToggleFor[dimension],
    },
    label,
  );

  const freqBtn = el(
    "button",
    {
      class: "chip-freq",
      type: "button",
      "aria-label": `Set frequency for ${label}`,
      title: `Set frequency for ${label}`,
      dataset: { dimension, key: String(key) },
      onclick: (e) => {
        e.stopPropagation();
        openFreqModal({ focus: { dimension, key, label } });
      },
    },
    "%",
  );

  const wrap = el(
    "span",
    {
      class: "chip-pair",
      dataset: { dimension, key: String(key) },
    },
    chip,
    freqBtn,
  );
  return wrap;
}

function syncFilterUI(root) {
  const f = store.filters;
  const wTypes    = f.weights?.types    ?? {};
  const wLevels   = f.weights?.levels   ?? {};
  const wRarities = f.weights?.rarities ?? {};

  // Per-dimension sums (with implicit weight 1 for any active chip lacking an
  // explicit weight) — same denominator the sampler uses, so the badge shows
  // the chip's TRUE share of the pool.
  const typesSum    = sumDim(f.types,    wTypes,    (k) => k);
  const levelsSum   = sumDim(f.levels,   wLevels,   (k) => String(k));
  const raritiesSum = sumDim(f.rarities, wRarities, (k) => k);

  for (const pair of root.querySelectorAll(".chip-pair")) {
    const dim = pair.dataset.dimension;
    const k = pair.dataset.key;
    const onSet =
      dim === "types"    ? f.types
    : dim === "levels"   ? f.levels
    :                      f.rarities;
    const isOn =
      dim === "levels" ? onSet.has(Number(k)) : onSet.has(k);

    const chip = pair.querySelector(".type-check, .level-chip, .rarity-chip");
    if (chip) chip.setAttribute("aria-pressed", String(isOn));

    const freqBtn = pair.querySelector(".chip-freq");
    const wMap =
      dim === "types"    ? wTypes
    : dim === "levels"   ? wLevels
    :                      wRarities;
    const hasWeight = k in wMap;

    // Off chips: hide the % button entirely so the chip falls back to its
    // native pill/square shape (CSS overrides are scoped to :not(--off)).
    pair.classList.toggle("chip-pair--off", !isOn);
    pair.classList.toggle("chip-pair--weighted", isOn && hasWeight);

    if (!isOn) {
      freqBtn.textContent = "%";
      freqBtn.title = `Set frequency for ${
        dim === "types"    ? k
      : dim === "levels"   ? `level ${k}`
      :                      `${k} rarity`
      }`;
      continue;
    }

    // Active chip: display the normalized share (weight ÷ section sum).
    // Implicit weight = 1 for any active chip without an explicit value,
    // matching the sampler's behavior in selectors.js.
    const myWeight = hasWeight ? Number(wMap[k]) : 1;
    const sum =
      dim === "types"    ? typesSum
    : dim === "levels"   ? levelsSum
    :                      raritiesSum;
    const sharePct = sum > 0 ? (myWeight / sum) * 100 : 0;
    freqBtn.textContent = `${Math.round(sharePct)}%`;
    freqBtn.title = hasWeight
      ? `Share of pool: ${sharePct.toFixed(1)}% (raw weight ${myWeight}) · click to adjust`
      : `Share of pool: ${sharePct.toFixed(1)}% (default weight) · click to adjust`;
  }
}

function sumDim(onSet, wMap, keyFn) {
  if (!onSet || onSet.size === 0) return 0;
  let s = 0;
  for (const k of onSet) {
    const lookup = keyFn(k);
    s += lookup in wMap ? Number(wMap[lookup]) : 1;
  }
  return s;
}
