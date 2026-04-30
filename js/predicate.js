// Runtime predicate evaluator for Foundry ChoiceSet rules.
//
// Subset of `tools/lib/foundry-predicate.mjs`. Foundry's full DSL is large;
// at runtime we only need to gate cascade choices, where every predicate
// we've observed in the data resolves to one of:
//
//   - String literal       — looked up in the runtime rolloption set
//   - Array of subpreds    — implicit AND
//   - {and: [...]}         — all must hold
//   - {or:  [...]}         — any must hold
//   - {not: pred}          — negation
//   - {nor: [...]}         — none may hold
//
// Anything else (numeric comparisons, actor refs, unknown shapes) is
// treated as FALSE — conservative-fail, matching the app's archetype-only
// stance: if Foundry encoded a gate we can't evaluate, we suppress the
// choice rather than fabricate one that may not apply.

export function evalPredicate(pred, rolloptions) {
  if (pred == null) return true;
  if (typeof pred === "string") {
    return rolloptions.has(pred);
  }
  if (Array.isArray(pred)) {
    return pred.every((p) => evalPredicate(p, rolloptions));
  }
  if (typeof pred !== "object") return false;
  if (Array.isArray(pred.and)) return pred.and.every((p) => evalPredicate(p, rolloptions));
  if (Array.isArray(pred.or))  return pred.or.some((p)  => evalPredicate(p, rolloptions));
  if ("not" in pred)           return !evalPredicate(pred.not, rolloptions);
  if (Array.isArray(pred.nor)) return !pred.nor.some((p) => evalPredicate(p, rolloptions));
  // Unknown combinator — conservative-fail.
  return false;
}
