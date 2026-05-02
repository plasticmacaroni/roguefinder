import { el } from "./util/dom.js";
import { store } from "./state.js";
import { fuzzyMatch, substringMatch } from "./util/fuzzy.js";

// Stacked-pill rendering: one pill per chain, displaying the lowest-level
// non-owned feat in the chain. A ⛓ button on the pill opens a popover
// listing the full chain with statuses; the user can switch which feat is
// the "displayed" one independently of build state via the popover.

const ID_DELIM = "|";

export function flattenChain(tree) {
  const out = [];
  (function walk(node) {
    out.push(node.id);
    for (const c of node.children) walk(c);
  })(tree);
  return out;
}

// Pick the feat to display on the pill: the lowest-level feat in the chain
// that is NOT in the build. If everything is in the build, show the
// highest-level feat (the chain "apex").
export function activeFeatId(allIds, build, byId) {
  const nonOwned = allIds.filter((id) => !build.has(id));
  if (nonOwned.length === 0) {
    let apex = allIds[0];
    for (const id of allIds) {
      if (byId.get(id).level > byId.get(apex).level) apex = id;
    }
    return apex;
  }
  let lowest = nonOwned[0];
  for (const id of nonOwned) {
    if (byId.get(id).level < byId.get(lowest).level) lowest = id;
  }
  return lowest;
}

// Render a single stacked pill representing the entire chain.
export function renderChainPill(tree, data) {
  const allIds = flattenChain(tree);
  const idsAttr = allIds.join(ID_DELIM);

  const pill = el("button", {
    class: "pill pill--chain",
    type: "button",
    "data-action": "toggle",
    "data-chain-ids": idsAttr,
    "data-chain-root": tree.id,
    title: "Chain",
  });

  // Internal nodes will be filled by syncChainPill. The legacy marker is
  // created up-front but starts hidden; sync toggles its hidden flag based
  // on the active feat's remaster boolean.
  pill.append(
    el("span", { class: "pill__name" }, "…"),
    el("span", { class: "pill__legacy", hidden: "" }, "[Pre-Remaster]"),
    el("span", { class: "pill__chain-count" }, "0/0"),
    el(
      "button",
      {
        class: "pill__chain",
        type: "button",
        "data-action": "chain-popover",
        "data-chain-ids": idsAttr,
        "aria-label": "Show chain",
      },
      "⛓",
    ),
    el(
      "button",
      {
        class: "pill__expand",
        type: "button",
        "data-action": "expand",
        "aria-label": "Open feat details",
      },
      "ⓘ",
    ),
  );

  syncChainPill(pill, data, store.build);
  return pill;
}

// Recompute and apply the active-feat display on a chain pill.
export function refreshChainPill(pill, data, build) {
  syncChainPill(pill, data, build);
}

// When the user searches, prefer a matching chain member as the displayed
// active feat — otherwise the chain pill keeps showing the closest-non-owned
// feat (e.g. "Vigilante Dedication") and the searched-for feat ("Startling
// Appearance (Vigilante)") is invisible inside the stack.
function querySwapId(allIds, byId, query) {
  const q = (query ?? "").trim();
  if (!q) return null;
  const useSubstring = q.length > 0 && q.length <= 3;
  const matcher = useSubstring ? substringMatch : fuzzyMatch;
  for (const id of allIds) {
    const f = byId.get(id);
    if (f && matcher(f.name, q)) return id;
  }
  return null;
}

function syncChainPill(pill, data, build) {
  const allIds = pill.dataset.chainIds.split(ID_DELIM);
  const queryMatchId = querySwapId(allIds, data.byId, store.query);
  const activeId = queryMatchId ?? activeFeatId(allIds, build, data.byId);
  const feat = data.byId.get(activeId);
  if (!feat) return;

  const owned = allIds.filter((id) => build.has(id)).length;
  const total = allIds.length;
  const isActiveInBuild = build.has(activeId);
  const allOwned = owned === total;

  pill.dataset.featId = activeId;
  pill.dataset.rarity = feat.rarity;
  pill.setAttribute("aria-pressed", String(isActiveInBuild));
  pill.setAttribute(
    "aria-label",
    `${feat.name} — chain (${owned}/${total} owned)`,
  );
  pill.title = `${feat.name} — chain (${owned}/${total})`;

  pill.querySelector(".pill__name").textContent = feat.name;
  // Legacy marker tracks the *active* feat, not the chain root — a chain
  // can mix legacy + remaster members, and the user cares about the one
  // currently displayed.
  const legacy = pill.querySelector(".pill__legacy");
  if (legacy) legacy.hidden = feat.remaster !== false;
  pill.querySelector(".pill__chain-count").textContent = `${owned}/${total}`;
  pill.classList.toggle("pill--chain-complete", allOwned);

  // The expand button mirrors the active feat too (so ⓘ opens the visible feat).
  const expand = pill.querySelector(".pill__expand");
  if (expand) expand.dataset.featId = activeId;

  // Lock state: a chain pill is "locked" if its currently displayed feat
  // can't be added to the build right now (i.e. its prereqs aren't met).
  // For chains, the lowest non-owned feat's prereqs are the in-chain root,
  // which by definition is owned at this point, so we mostly stay unlocked.
  // But cross-chain wildcard prereqs may still lock. Re-evaluate via
  // selectors.isLocked equivalent: we re-use the same shape via grid.js.
  // (Lock visual is handled by grid.js refreshLocks, which sets data-feat-id
  // first then computes the lock — that ordering works.)
}
