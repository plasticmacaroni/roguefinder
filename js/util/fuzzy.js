// Hand-rolled fuzzy matcher. Normalize + subsequence test. ~25 lines.
// Good enough for ~5K short strings; no external dep.

export function normalize(s) {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns true if every character of `query` appears in `target` in order
// (subsequence). Allows gaps. Cheap and forgiving.
export function fuzzyMatch(target, query) {
  if (!query) return true;
  const q = normalize(query);
  if (!q) return true;
  const t = normalize(target);
  let i = 0;
  for (const ch of q) {
    i = t.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

// Stronger filter: substring match. Used as a fast pass for short queries.
export function substringMatch(target, query) {
  if (!query) return true;
  return normalize(target).includes(normalize(query));
}
