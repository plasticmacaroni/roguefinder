import { el } from "./util/dom.js";
import { store, getData } from "./state.js";
import { formatFeatLabel } from "./format.js";

// Render a single feat as an interactive pill.
//   - Click body: toggle build (no-op when locked)
//   - Click ⓘ:    open detail (always allowed; reading is fine even when locked)
// The pill exposes data-feat-id for event delegation; consumers may attach
// click handlers at the section level instead of per-pill.

export function renderPill(feat, { selected = false, locked = false, auto = false } = {}) {
  // Inline SVG info icon — geometrically centered, unaffected by font glyph quirks.
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "info-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    '<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<circle cx="8" cy="4.6" r="0.95" fill="currentColor"/>' +
    '<rect x="7.1" y="6.7" width="1.8" height="5.6" rx="0.5" fill="currentColor"/>';
  const expand = el(
    "button",
    {
      class: "pill__expand",
      "data-action": "expand",
      "data-feat-id": feat.id,
      "aria-label": `Open details for ${feat.name}`,
      type: "button",
    },
    svg,
  );

  const data = getData();
  const displayName = formatFeatLabel(feat, store.picks, data?.translate);

  const cls =
    "pill" +
    (locked ? " is-locked" : "") +
    (auto ? " pill--auto" : "");
  const attrs = {
    class: cls,
    type: "button",
    "data-rarity": feat.rarity,
    "data-feat-id": feat.id,
    // Auto pills are read-only — omit data-action="toggle" so the grid's
    // click delegation skips them. Expand (ⓘ) still works.
    ...(auto ? {} : { "data-action": "toggle" }),
    "aria-pressed": String(selected || auto),
    "aria-disabled": String(locked || auto),
    "aria-label":
      `${displayName} — ${feat.type}, level ${feat.level}, ${feat.rarity}` +
      (auto ? " (auto-applied free feat)" : selected ? " (in build)" : "") +
      (locked ? " (locked: prereq not in build)" : ""),
    title: auto
      ? `${feat.name} — auto-applied because another feat needs it`
      : locked
        ? `${feat.name} — locked. Prereq: ${feat.prereq_text || "see details"}`
        : feat.name,
  };
  const children = [el("span", { class: "pill__name" }, displayName)];
  // Locked feats with literal prereq prose surface that prose inline so the
  // user sees "X or Y" right on the pill instead of having to expand it.
  if (locked && feat.prereq_text) {
    children.push(
      el("span", { class: "pill__hint" }, feat.prereq_text),
    );
  }
  children.push(expand);
  const pill = el("button", attrs, ...children);

  return pill;
}

// Update an existing pill's selected state without rebuilding.
export function setPillSelected(pillEl, selected) {
  pillEl.setAttribute("aria-pressed", String(selected));
}

export function setPillLocked(pillEl, locked, prereqText = "") {
  pillEl.classList.toggle("is-locked", locked);
  pillEl.setAttribute("aria-disabled", String(locked));
  const name = pillEl.querySelector(".pill__name")?.textContent ?? "";
  pillEl.title = locked
    ? `${name} — locked. Prereq: ${prereqText || "see details"}`
    : name;
  // Inline hint sync so dynamic locks/unlocks add or strip the subtitle.
  let hint = pillEl.querySelector(".pill__hint");
  if (locked && prereqText) {
    if (!hint) {
      hint = document.createElement("span");
      hint.className = "pill__hint";
      const expand = pillEl.querySelector(".pill__expand");
      pillEl.insertBefore(hint, expand ?? null);
    }
    hint.textContent = prereqText;
  } else if (hint) {
    hint.remove();
  }
}

export function setPillHidden(pillEl, hidden) {
  pillEl.classList.toggle("is-hidden", hidden);
}
