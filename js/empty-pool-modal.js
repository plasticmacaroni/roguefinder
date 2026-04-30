// Popup that explains why the rollable pool is empty and offers one-click
// escape hatches that clear individual filter dimensions or all of them.
//
// Triggered by the Spin button when rollablePool yields zero feats.

import { el } from "./util/dom.js";
import {
  setFilterTypes,
  setFilterLevels,
  setFilterRarities,
  clearFilters,
} from "./state.js";

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, unique: 3 };

export function openEmptyPoolModal({ filters }) {
  const types    = [...filters.types];
  const levels   = [...filters.levels].sort((a, b) => a - b);
  const rarities = [...filters.rarities].sort(
    (a, b) => (RARITY_ORDER[a] ?? 99) - (RARITY_ORDER[b] ?? 99),
  );

  const dialog = el("dialog", {
    class: "share-load-dialog empty-pool-modal",
    "aria-labelledby": "empty-pool-title",
  });

  const cleanup = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  const close = () => cleanup();

  const summaryRow = (label, items) =>
    el(
      "div",
      { class: "empty-pool-modal__summary-row" },
      el("span", { class: "empty-pool-modal__summary-label" }, label),
      el(
        "span",
        { class: "empty-pool-modal__summary-value" },
        items.length ? items.join(", ") : "Any",
      ),
    );

  const head = el(
    "div",
    { class: "share-load-dialog__head" },
    el(
      "h2",
      { class: "share-load-dialog__title", id: "empty-pool-title" },
      "No feats match your filters",
    ),
    el(
      "button",
      {
        class: "share-load-dialog__close",
        type: "button",
        "aria-label": "Close",
        onclick: close,
      },
      "✕",
    ),
  );

  const body = el(
    "p",
    { class: "share-load-dialog__body" },
    "Your current filter combination yields zero rollable feats. Pick one below to widen the pool, or close this and adjust the chips manually.",
  );

  const summary = el(
    "div",
    { class: "empty-pool-modal__summary" },
    summaryRow("Types",    types),
    summaryRow("Levels",   levels.map(String)),
    summaryRow("Rarities", rarities.map(cap)),
  );

  // Build the choice stack — only show clear buttons for dimensions that are
  // actually constraining the pool. The "Clear all" + Cancel buttons are
  // always available.
  const choices = el("div", { class: "share-load-dialog__choices" });

  if (rarities.length > 0) {
    choices.appendChild(
      buildChoice({
        title: "Clear rarity filter",
        sub: `Drop the rarity restriction (${rarities.map(cap).join(", ")}).`,
        primary: true,
        onclick: () => { setFilterRarities([]); close(); },
      }),
    );
  }
  if (levels.length > 0) {
    choices.appendChild(
      buildChoice({
        title: "Clear level filter",
        sub: `Drop level restrictions (${levels.join(", ")}).`,
        onclick: () => { setFilterLevels([]); close(); },
      }),
    );
  }
  if (types.length > 0) {
    choices.appendChild(
      buildChoice({
        title: "Clear type filter",
        sub: `Drop type restrictions (${types.join(", ")}).`,
        onclick: () => { setFilterTypes([]); close(); },
      }),
    );
  }
  choices.appendChild(
    buildChoice({
      title: "Clear all filters",
      sub: "Reset every filter so the full pool is rollable.",
      danger: true,
      onclick: () => { clearFilters(); close(); },
    }),
  );
  choices.appendChild(
    buildChoice({
      title: "Cancel",
      sub: "Close this dialog without changing anything.",
      ghost: true,
      onclick: close,
    }),
  );

  dialog.append(head, body, summary, choices);
  document.body.appendChild(dialog);
  dialog.showModal();

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
}

function buildChoice({ title, sub, onclick, primary, danger, ghost }) {
  const cls = [
    "share-load-dialog__btn",
    primary && "share-load-dialog__btn--primary",
    danger  && "share-load-dialog__btn--danger",
    ghost   && "share-load-dialog__btn--ghost",
  ].filter(Boolean).join(" ");
  return el(
    "button",
    { class: cls, type: "button", onclick },
    el("span", { class: "share-load-dialog__btn-title" }, title),
    el("span", { class: "share-load-dialog__btn-sub" }, sub),
  );
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
