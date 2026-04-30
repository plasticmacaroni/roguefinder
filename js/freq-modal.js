// Unified weights modal. Replaces the per-chip popover.
//
// Mental model: each row's slider/number value IS the user's intended
// percentage for that chip — independent input, never auto-adjusted by other
// rows. The "actual %" readout on the right shows the row's TRUE share of
// the section sum (live), so the user sees both their intent AND the
// resulting sampling probability at all times.
//
// Save commits all weights atomically via setAllWeights. Cancel discards.

import { el } from "./util/dom.js";
import { store, setAllWeights } from "./state.js";
import { showToast } from "./toast.js";

const RAW_MAX = 100;

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, unique: 3 };

export function openFreqModal({ focus } = {}) {
  const activeTypes = [...store.filters.types];
  const activeLevels = [...store.filters.levels].sort((a, b) => a - b);
  const activeRarities = [...store.filters.rarities].sort(
    (a, b) => (RARITY_ORDER[a] ?? 99) - (RARITY_ORDER[b] ?? 99),
  );

  if (
    activeTypes.length === 0 &&
    activeLevels.length === 0 &&
    activeRarities.length === 0
  ) {
    showToast("Toggle a Type, Level, or Rarity chip first to set frequencies.");
    return;
  }

  // Draft = deep-copy of stored weights, with per-dimension default backfill
  // for any active chip lacking an explicit weight.
  const wTypesStore    = store.filters.weights?.types    ?? {};
  const wLevelsStore   = store.filters.weights?.levels   ?? {};
  const wRaritiesStore = store.filters.weights?.rarities ?? {};
  const tDefault = activeTypes.length    > 0 ? Math.round(100 / activeTypes.length)    : 0;
  const lDefault = activeLevels.length   > 0 ? Math.round(100 / activeLevels.length)   : 0;
  const rDefault = activeRarities.length > 0 ? Math.round(100 / activeRarities.length) : 0;
  const draft = { types: {}, levels: {}, rarities: {} };
  for (const t of activeTypes) {
    draft.types[t] = t in wTypesStore ? Number(wTypesStore[t]) : tDefault;
  }
  for (const n of activeLevels) {
    draft.levels[n] = String(n) in wLevelsStore ? Number(wLevelsStore[String(n)]) : lDefault;
  }
  for (const r of activeRarities) {
    draft.rarities[r] = r in wRaritiesStore ? Number(wRaritiesStore[r]) : rDefault;
  }

  const dialog = el("dialog", {
    class: "freq-modal",
    "aria-labelledby": "freq-modal-title",
  });

  const cleanup = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };

  const onCancel = () => cleanup();

  const onSave = () => {
    // Auto-balance each dimension to sum = 100 on save so the persisted
    // values match the user's mental "% of pool" model. Sliders inside the
    // modal stay independent (no surprise rebalancing during edit), but the
    // final write is normalized.
    const types    = balanceTo100(draft.types);
    const levels   = balanceTo100(draft.levels);
    const rarities = balanceTo100(draft.rarities);
    setAllWeights({ types, levels, rarities });
    showToast("Frequencies saved.");
    cleanup();
  };

  // --- Header ---
  const head = el(
    "div",
    { class: "freq-modal__head" },
    el(
      "h2",
      { class: "freq-modal__title", id: "freq-modal-title" },
      "Tune frequencies",
    ),
    el(
      "button",
      {
        class: "freq-modal__close",
        type: "button",
        "aria-label": "Cancel",
        onclick: onCancel,
      },
      "✕",
    ),
  );

  const intro = el(
    "p",
    { class: "freq-modal__intro" },
    'Higher number = picked more often. Each slider is independent — moving one does NOT change the others. The "actual %" on the right shows each chip\'s TRUE share of rolls. Numbers don\'t have to add up to 100.',
  );

  // --- Sections ---
  // Each section keeps refs to its row controls so the per-row "actual %" and
  // the section sum readout can be updated in O(N) without re-rendering.
  const sections = [];

  if (activeTypes.length > 0) {
    sections.push(
      buildSection({
        dimension: "types",
        title: "Types",
        keys: activeTypes,
        labelFor: (t) => t,
        chipClass: "type-check",
        draft,
        focus,
      }),
    );
  }
  if (activeLevels.length > 0) {
    sections.push(
      buildSection({
        dimension: "levels",
        title: "Levels",
        keys: activeLevels.map(String),
        labelFor: (k) => k,
        chipClass: "level-chip",
        draft,
        focus,
      }),
    );
  }
  if (activeRarities.length > 0) {
    sections.push(
      buildSection({
        dimension: "rarities",
        title: "Rarities",
        keys: activeRarities,
        labelFor: (r) => r[0].toUpperCase() + r.slice(1),
        chipClass: "rarity-chip",
        draft,
        focus,
      }),
    );
  }

  // --- Footer ---
  const footer = el(
    "div",
    { class: "freq-modal__actions" },
    el(
      "button",
      {
        class: "freq-modal__btn freq-modal__btn--ghost",
        type: "button",
        onclick: onCancel,
      },
      "Cancel",
    ),
    el(
      "button",
      {
        class: "freq-modal__btn freq-modal__btn--primary",
        type: "button",
        onclick: onSave,
      },
      "Save",
    ),
  );

  dialog.append(head, intro, ...sections.map((s) => s.el), footer);
  document.body.appendChild(dialog);
  dialog.showModal();

  // Block backdrop/Esc auto-close so user has to pick Cancel or Save.
  // (Esc still maps to Cancel via the cancel-event handler below.)
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    onCancel();
  });

  // Focus the requested row, if any.
  if (focus) {
    const target = sections.find((s) => s.dimension === focus.dimension);
    if (target) {
      const row = target.rowsByKey.get(String(focus.key));
      if (row) {
        row.range.focus();
        row.host.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  // Initial paint of all "actual %" + sum readouts.
  for (const s of sections) s.recompute();
}

// ---- Section builder ----

function buildSection({
  dimension,
  title,
  keys,
  labelFor,
  chipClass,
  draft,
  focus,
}) {
  const sumNode = el("span", { class: "freq-modal__sum" }, "");
  const head = el(
    "div",
    { class: "freq-modal__section-head" },
    el("h3", { class: "freq-modal__section-title" }, title),
    sumNode,
  );

  const rowsByKey = new Map();
  const rowEls = [];
  for (const key of keys) {
    const row = buildRow({
      dimension,
      key,
      label: labelFor(key),
      chipClass,
      draft,
      isFocused: focus?.dimension === dimension && String(focus?.key) === String(key),
      onChange: () => recompute(),
    });
    rowsByKey.set(String(key), row);
    rowEls.push(row.host);
  }

  const onResetEqual = () => {
    const equal = Math.round(100 / keys.length);
    for (const key of keys) {
      draft[dimension][key] = equal;
      const row = rowsByKey.get(String(key));
      if (row) row.write(equal);
    }
    recompute();
  };
  const onBalance100 = () => {
    const sum = sumDraft(dimension, keys, draft);
    if (sum <= 0) {
      showToast("All values are zero — use Reset to equal first.");
      return;
    }
    let scaledSum = 0;
    const scaled = {};
    for (const key of keys) {
      const v = Math.round((Number(draft[dimension][key]) || 0) * (100 / sum));
      const clamped = clamp(v, 0, RAW_MAX);
      scaled[key] = clamped;
      scaledSum += clamped;
    }
    // Apply rounding-drift correction to the row with the largest value.
    const drift = 100 - scaledSum;
    if (drift !== 0) {
      let maxKey = keys[0];
      let maxVal = -Infinity;
      for (const key of keys) {
        if (scaled[key] > maxVal) {
          maxVal = scaled[key];
          maxKey = key;
        }
      }
      scaled[maxKey] = clamp(scaled[maxKey] + drift, 0, RAW_MAX);
    }
    for (const key of keys) {
      draft[dimension][key] = scaled[key];
      rowsByKey.get(String(key))?.write(scaled[key]);
    }
    recompute();
  };

  const sectionActions = el(
    "div",
    { class: "freq-modal__section-actions" },
    el(
      "button",
      {
        class: "freq-modal__btn freq-modal__btn--ghost",
        type: "button",
        onclick: onResetEqual,
      },
      "Reset to equal",
    ),
    el(
      "button",
      {
        class: "freq-modal__btn freq-modal__btn--ghost",
        type: "button",
        onclick: onBalance100,
      },
      "Balance to 100",
    ),
  );

  const sectionEl = el(
    "section",
    { class: "freq-modal__section", dataset: { dimension } },
    head,
    el("div", { class: "freq-modal__rows" }, rowEls),
    sectionActions,
  );

  function recompute() {
    const sum = sumDraft(dimension, keys, draft);
    sumNode.textContent =
      sum === 100 ? "Sum: 100 ✓" : `Sum: ${sum}`;
    sumNode.classList.toggle("freq-modal__sum--ok", sum === 100);
    sumNode.classList.toggle("freq-modal__sum--off", sum !== 100);
    for (const key of keys) {
      const row = rowsByKey.get(String(key));
      if (!row) continue;
      const val = Number(draft[dimension][key]) || 0;
      const actual = sum > 0 ? (val / sum) * 100 : 0;
      row.actualNode.textContent = sum > 0 ? `${actual.toFixed(1)}%` : "—";
    }
  }

  return { dimension, el: sectionEl, rowsByKey, recompute };
}

// ---- Row builder ----

function buildRow({ dimension, key, label, chipClass, draft, isFocused, onChange }) {
  const initial = Number(draft[dimension][key]) || 0;

  const chipAttrs = {
    class: `${chipClass} freq-modal__row-chip`,
    "aria-pressed": "true",
  };
  // Rarity chips need data-rarity for the per-rarity color tokens.
  if (chipClass === "rarity-chip") {
    chipAttrs.dataset = { rarity: String(key) };
  }
  const chip = el("span", chipAttrs, label);

  const range = el("input", {
    type: "range",
    class: "freq-modal__row-slider",
    min: "0",
    max: String(RAW_MAX),
    step: "1",
    value: String(initial),
    "aria-label": `Frequency for ${label}`,
  });

  const number = el("input", {
    type: "number",
    class: "freq-modal__row-number",
    min: "0",
    max: String(RAW_MAX),
    step: "1",
    value: String(initial),
    "aria-label": `Frequency value for ${label}`,
  });

  const percentGlyph = el("span", { class: "freq-modal__row-percent" }, "%");
  const arrow = el("span", { class: "freq-modal__row-arrow", "aria-hidden": "true" }, "→");
  const actualNode = el("span", { class: "freq-modal__row-actual" }, "—");

  const host = el(
    "div",
    {
      class: "freq-modal__row" + (isFocused ? " freq-modal__row--focused" : ""),
      dataset: { dimension, key: String(key) },
    },
    chip,
    range,
    number,
    percentGlyph,
    arrow,
    actualNode,
  );

  function write(v) {
    const clamped = clamp(Number(v) || 0, 0, RAW_MAX);
    range.value = String(clamped);
    number.value = String(clamped);
    draft[dimension][key] = clamped;
  }

  range.addEventListener("input", () => {
    const v = clamp(Number(range.value) || 0, 0, RAW_MAX);
    number.value = String(v);
    draft[dimension][key] = v;
    onChange();
  });
  number.addEventListener("input", () => {
    // Allow free typing — don't commit while the field is empty (user is
    // probably between a delete and a re-entry). Empty string would coerce
    // to 0 and stomp the row prematurely.
    if (number.value === "") return;
    const raw = Number(number.value);
    if (!Number.isFinite(raw)) return;
    const v = clamp(raw, 0, RAW_MAX);
    range.value = String(v);
    draft[dimension][key] = v;
    onChange();
  });
  number.addEventListener("blur", () => {
    // On blur, snap the visible number input to the clamped integer state.
    const v = clamp(Number(number.value) || 0, 0, RAW_MAX);
    number.value = String(v);
    range.value = String(v);
    draft[dimension][key] = v;
    onChange();
  });

  return { host, range, number, actualNode, write };
}

// ---- helpers ----

function sumDraft(dimension, keys, draft) {
  let s = 0;
  for (const key of keys) s += Number(draft[dimension][key]) || 0;
  return s;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Scale a {key: number} map so values sum to exactly 100. Every key in the
// map is by definition an active chip, so it gets a 1% floor — no chip ever
// collapses to 0 from rounding. Drift is patched onto the largest entry,
// or for over-shoot, peeled off the largest entries (never below the floor).
//
// If keys.length > 100 the floor is mathematically incompatible with the
// sum-to-100 constraint; in that defensive branch the floor is dropped and
// the original proportional rounding stands. (The active chip set in this
// app tops out at ~30 across all dimensions.)
function balanceTo100(map) {
  const keys = Object.keys(map);
  const n = keys.length;
  if (n === 0) return {};

  const FLOOR = n <= 100 ? 1 : 0;

  let sum = 0;
  for (const k of keys) sum += Number(map[k]) || 0;

  const out = {};

  if (sum <= 0) {
    // No information to scale by — split evenly with the floor enforced.
    const base = Math.max(FLOOR, Math.floor(100 / n));
    for (const k of keys) out[k] = base;
  } else {
    for (const k of keys) {
      const raw = (Number(map[k]) || 0) * (100 / sum);
      out[k] = Math.max(FLOOR, Math.round(raw));
    }
  }

  let scaledSum = 0;
  for (const k of keys) scaledSum += out[k];
  let drift = 100 - scaledSum;

  if (drift > 0) {
    // Add to the largest entry.
    let maxKey = keys[0];
    for (const k of keys) if (out[k] > out[maxKey]) maxKey = k;
    out[maxKey] = clamp(out[maxKey] + drift, 0, 100);
  } else if (drift < 0) {
    // Subtract one at a time from the largest entries, never below FLOOR.
    let remaining = -drift;
    const sorted = [...keys].sort((a, b) => out[b] - out[a]);
    let guard = 1000; // hard cap against pathological loops
    while (remaining > 0 && guard-- > 0) {
      let progressed = false;
      for (const k of sorted) {
        if (remaining === 0) break;
        if (out[k] > FLOOR) {
          out[k] -= 1;
          remaining -= 1;
          progressed = true;
        }
      }
      if (!progressed) break; // can't go lower without violating the floor
    }
  }

  return out;
}
