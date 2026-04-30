import { el } from "./util/dom.js";
import { store, toggleBuild } from "./state.js";
import { requirementsSatisfied } from "./selectors.js";
import { showToast } from "./toast.js";

// Popover anchored to a chain pill's ⛓ icon. Each row toggles its feat in
// the build (with cascade-orphan removal handled by toggleBuild). A per-row
// ⓘ button opens the detail modal for that feat.

let current = null; // { popover, anchor, escHandler, clickHandler, ctx }

export function openChainPopover(anchor, ids, data, onOpenDetail) {
  closeChainPopover();
  const ctx = { anchor, ids, data, onOpenDetail };
  const popover = buildPopover(ctx);
  document.body.appendChild(popover);
  positionPopover(popover, anchor);

  const escHandler = (e) => {
    if (e.key === "Escape") closeChainPopover();
  };
  const clickHandler = (e) => {
    if (!popover.contains(e.target) && !anchor.contains(e.target)) {
      closeChainPopover();
    }
  };
  document.addEventListener("keydown", escHandler);
  setTimeout(() => document.addEventListener("click", clickHandler), 0);

  current = { popover, anchor, escHandler, clickHandler, ctx };
}

export function closeChainPopover() {
  if (!current) return;
  const { popover, escHandler, clickHandler } = current;
  popover.remove();
  document.removeEventListener("keydown", escHandler);
  document.removeEventListener("click", clickHandler);
  current = null;
}

function rerender() {
  if (!current) return;
  const { popover, ctx } = current;
  const fresh = buildPopover(ctx);
  // Replace contents in place so position is preserved.
  popover.replaceChildren(...fresh.childNodes);
}

function buildPopover(ctx) {
  const { ids, data } = ctx;
  const build = store.build;

  // Active feat = lowest-level non-owned (matches chain-pill).
  let activeId = null;
  let lowestLvl = Infinity;
  for (const id of ids) {
    if (build.has(id)) continue;
    const f = data.byId.get(id);
    if (f && f.level < lowestLvl) {
      lowestLvl = f.level;
      activeId = id;
    }
  }

  const list = el("div", { class: "chain-popover__list" });

  const sorted = ids
    .map((id) => data.byId.get(id))
    .filter(Boolean)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

  for (const feat of sorted) {
    list.appendChild(rowFor(feat, activeId, ctx));
  }

  return el(
    "div",
    {
      class: "chain-popover",
      role: "dialog",
      "aria-label": "Chain feats",
    },
    el(
      "div",
      { class: "chain-popover__header" },
      `Chain · ${ids.length} feats · ${ids.filter((id) => build.has(id)).length} owned · click to add/remove`,
    ),
    list,
  );
}

function rowFor(feat, activeId, ctx) {
  const { data, onOpenDetail } = ctx;
  const build = store.build;
  const isOwned = build.has(feat.id);
  const isActive = feat.id === activeId;
  const auto = store.autoBuild;
  const owned = auto && auto.size > 0
    ? new Set([...build, ...auto.keys()])
    : build;
  const reqMet = requirementsSatisfied(feat, owned, data.byId);
  const isLocked = !isOwned && !reqMet;

  let status = "·";
  if (isOwned) status = "✓";
  else if (isActive) status = "▶";
  else if (isLocked) status = "🔒";

  const cls = [
    "chain-popover__item",
    isOwned && "chain-popover__item--owned",
    isLocked && "chain-popover__item--locked",
    isActive && "chain-popover__item--active",
  ]
    .filter(Boolean)
    .join(" ");

  const row = el(
    "div",
    { class: cls, dataset: { featId: feat.id } },
    el(
      "button",
      {
        class: "chain-popover__row",
        type: "button",
        "aria-label": isOwned ? `Remove ${feat.name}` : `Add ${feat.name}`,
        disabled: isLocked && !isOwned ? true : undefined,
        onclick: () => onRowToggle(feat, ctx),
      },
      el("span", { class: "chain-popover__item-status" }, status),
      el("span", { class: "chain-popover__item-name" }, feat.name),
      el("span", { class: "chain-popover__item-level" }, `L${feat.level}`),
    ),
    el(
      "button",
      {
        class: "chain-popover__info",
        type: "button",
        "aria-label": `Open details for ${feat.name}`,
        onclick: (e) => {
          e.stopPropagation();
          onOpenDetail(feat);
          closeChainPopover();
        },
      },
      "ⓘ",
    ),
  );

  return row;
}

function onRowToggle(feat, ctx) {
  const wasIn = store.build.has(feat.id);
  const orphans = toggleBuild(feat.id);
  if (wasIn && orphans.length > 0) {
    const names = orphans
      .map((id) => ctx.data.byId.get(id)?.name)
      .filter(Boolean);
    showToast(
      `Removed ${feat.name} — also pulled ${names.length} dependent ${
        names.length === 1 ? "feat" : "feats"
      }: ${names.join(", ")}`,
    );
  } else if (wasIn) {
    showToast(`Removed ${feat.name}`);
  } else {
    showToast(`Added ${feat.name}`);
  }
  rerender();
}

function positionPopover(popover, anchor) {
  const r = anchor.getBoundingClientRect();
  const top = window.scrollY + r.bottom + 6;
  let left = window.scrollX + r.right - popover.offsetWidth;
  left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - popover.offsetWidth - 8));
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}
