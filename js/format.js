// Formatting helpers for feats with resolved Foundry ChoiceSet picks.
// Returns the display label users see on pills, in build summary, and in
// the detail meta row. When a feat has chosen ChoiceSet values, append
// them in parens so "Terrain Stalker" reads as "Terrain Stalker (Rubble)".

import { evalPredicate } from "./predicate.js";
import { deriveRolloptions } from "./state.js";

// Resolve a feat's chosen choice values to a list of human strings,
// using `translate` for i18n keys (with heuristic fallback). Returns an
// empty array when the feat has no choices or no resolutions. Order
// matches `feat.choices` (deterministic per feat). Choices whose Foundry
// predicate is no longer satisfied (e.g. an old class-gated pick where
// the gating rolloptions no longer hold) are silently dropped — keeps
// pills clean if a stale persisted pick survives a rule change.
export function resolveChoiceLabels(feat, picks, translate, byId) {
  if (!feat?.choices?.length) return [];
  const featPicks = picks?.get?.(feat.id);
  if (!featPicks?.choiceSets) return [];
  const tr = typeof translate === "function" ? translate : (k) => k;
  const rolloptions = deriveRolloptions(picks, byId);
  const out = [];
  for (const choice of feat.choices) {
    const value = featPicks.choiceSets[choice.id];
    if (!value) continue;
    if (choice.predicate && !evalPredicate(choice.predicate, rolloptions)) continue;
    // Freetext picks have no option metadata — the persisted value IS
    // the user's typed string. Optionally wrap with a labelPrefix so
    // the pill reads "Lore (Cooking)" instead of bare "Cooking".
    if (choice.kind === "freetext") {
      out.push(choice.labelPrefix ? `${choice.labelPrefix} (${value})` : String(value));
      continue;
    }
    const opt = (choice.options ?? []).find((o) => o.value === value);
    if (!opt) {
      // Choice value persisted but option metadata gone (data churn) —
      // surface the raw value rather than dropping silently.
      out.push(String(value));
      continue;
    }
    out.push(tr(opt.label) || opt.value);
  }
  return out;
}

// Build the display label for a feat, appending resolved choice values
// in parens. "Terrain Stalker (Rubble)", "Echo of the Fallen (Stealth · Longsword)".
export function formatFeatLabel(feat, picks, translate) {
  const labels = resolveChoiceLabels(feat, picks, translate);
  if (labels.length === 0) return feat.name;
  return `${feat.name} (${labels.join(" · ")})`;
}
