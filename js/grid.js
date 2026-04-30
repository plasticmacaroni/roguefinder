import { el, clearChildren } from "./util/dom.js";
import { renderPill, setPillSelected, setPillLocked, setPillHidden } from "./pill.js";
import { renderChainPill, refreshChainPill, flattenChain } from "./chain-pill.js";
import { isLocked, visibleIdSet } from "./selectors.js";
import { getSectionOpen, setSectionOpen } from "./section-state.js";
import { renderTypeGroup } from "./build-summary.js";
// renderFreeFeats stands alone (called from main.js outside the grid wrapper),
// so it needs direct access to the store + subscribe rather than via the
// {store, subscribe} bag renderGrid receives.
import { store, subscribe } from "./state.js";

// Render the manual selection grid into a self-owned wrapper, appended to
// `container`. Subscribes to store changes so pill selected-state, lock
// state, visibility, and section counts update without DOM rebuild.
// IMPORTANT: This function owns ONLY the wrapper it creates. It must NOT
// clear or otherwise touch siblings in `container` (nav, filters, etc).

export function renderGrid(container, data, { store, subscribe }) {
  const wrapper = document.createElement("div");
  wrapper.className = "feat-grid";

  const sections = [];
  for (const type of data.typeOrder) {
    const ids = data.byType.get(type);
    if (!ids?.length) continue;
    sections.push(renderSection(type, ids, data));
  }
  wrapper.append(...sections);

  container.appendChild(wrapper);

  // From here on, `container` refers to the wrapper for delegation purposes
  // so events stay scoped to the grid.
  container = wrapper;

  // Click delegation: handle pill toggles + expand + chain-popover.
  container.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "toggle") {
      // Don't toggle when the click came from a sub-button.
      if (e.target.closest('[data-action="expand"], [data-action="chain-popover"]')) return;
      if (action.classList.contains("is-locked")) return;
      onToggle(action.dataset.featId);
    } else if (action.dataset.action === "expand") {
      e.stopPropagation();
      onExpand(action.dataset.featId);
    } else if (action.dataset.action === "chain-popover") {
      e.stopPropagation();
      onChainPopover(action);
    }
  });

  // Sync pill selection + lock state + counts on build changes.
  subscribe("build", (build) => {
    refreshChainPills(container, data, build);
    refreshSelection(container, build, data);
    refreshLocks(container, build, data, store.autoBuild);
    refreshCounts(container, build, data);
    refreshVisibility(container, store.filters, store.query, data);
  });
  // autoBuild changes (driven by build) — re-evaluate locks.
  subscribe("autoBuild", (autoBuild) => {
    refreshLocks(container, store.build, data, autoBuild);
  });
  // Filter / query → visibility refresh.
  subscribe("filters", () => refreshVisibility(container, store.filters, store.query, data));
  subscribe("query", () => {
    // Chain pills swap their displayed active feat to a search-matching
    // member when the user is searching, so e.g. "startling" surfaces
    // "Startling Appearance (Vigilante)" instead of "Vigilante Dedication"
    // inside the chain that owns it. Lock visuals follow the new active
    // id so a swapped-in unowned feat shows the proper locked state.
    refreshChainPills(container, data, store.build);
    refreshLocks(container, store.build, data, store.autoBuild);
    refreshVisibility(container, store.filters, store.query, data);
  });

  // Initial sync (filters/build may already be non-empty from defaults / restore).
  refreshChainPills(container, data, store.build);
  refreshSelection(container, store.build, data);
  refreshLocks(container, store.build, data, store.autoBuild);
  refreshVisibility(container, store.filters, store.query, data);
  refreshCounts(container, store.build, data);
}

// "Free Feats" section — rendered as a top-level sibling (not inside the
// grid) so callers can mount it directly under the build summary. Hidden
// until autoBuild has at least one entry.
export function renderFreeFeats(parent, data) {
  const section = el(
    "details",
    {
      class: "feat-section feat-section--free",
      dataset: { type: "FreeFeats" },
      open: getSectionOpen("FreeFeats", true),
      style: "display:none",
    },
    el(
      "summary",
      {},
      el("span", {}, "Free Feats"),
      el(
        "span",
        { class: "feat-section__counts", dataset: { type: "FreeFeats" } },
        "0 auto-applied",
      ),
    ),
    el("div", { class: "feat-section__body" }),
  );
  section.addEventListener("toggle", () => {
    setSectionOpen("FreeFeats", section.open);
  });
  parent.appendChild(section);

  // Click delegation: only the ⓘ expand button is wired here. Auto pills
  // skip data-action="toggle", so build mutations from this section are
  // impossible by construction.
  section.addEventListener("click", (e) => {
    const expand = e.target.closest('[data-action="expand"]');
    if (!expand) return;
    e.stopPropagation();
    onExpand(expand.dataset.featId);
  });

  function refresh(autoBuild) {
    refreshFreeFeats(section, data, autoBuild);
  }

  subscribe("autoBuild", refresh);
  // Picks change → re-render pill labels (which include choice values)
  // even when autoBuild doesn't change.
  subscribe("picks", () => refresh(store.autoBuild));
  // Initial paint with whatever's in the store right now.
  refresh(store.autoBuild);
  return section;
}

function refreshChainPills(container, data, build) {
  for (const pill of container.querySelectorAll(".pill--chain")) {
    refreshChainPill(pill, data, build);
  }
}

let onToggle = () => {};
let onExpand = () => {};
let onChainPopover = () => {};

export function setGridHandlers({ toggle, expand, chainPopover }) {
  onToggle = toggle;
  onExpand = expand;
  if (chainPopover) onChainPopover = chainPopover;
}

// --- internals ---

function renderSection(type, ids, data) {
  const total = ids.length;

  // Class type splits further by class.
  if (type === "Class") {
    const byClass = new Map();
    for (const id of ids) {
      const f = data.byId.get(id);
      const key = f.class ?? "(Multi-class / shared)";
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key).push(id);
    }

    const subgroups = [...byClass.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cls, group]) =>
        el(
          "div",
          { class: "subgroup", dataset: { subgroup: cls } },
          el("h3", { class: "subgroup__title" }, `${cls} (${group.length})`),
          renderGroupBody(group, data),
        ),
      );

    return sectionShell(type, total, subgroups);
  }

  return sectionShell(type, total, renderGroupBody(ids, data));
}

// Render a body that mixes standalone pills and stacked chain pills. Chain
// pills represent an entire chain as one stacked-looking pill labeled with
// the closest-non-owned feat; the user can switch which feat is displayed
// via the chain (⛓) popover on the right of the pill.
function renderGroupBody(ids, data) {
  const layout = buildGroupLayout(ids, data);
  const entries = [];

  // Standalone feats: { kind: "feat", feat }
  for (const id of layout.standalone) {
    entries.push({ kind: "feat", feat: data.byId.get(id), sortLevel: data.byId.get(id).level, sortName: data.byId.get(id).name });
  }
  // Chain trees: { kind: "chain", tree, sortLevel = root level, sortName = root name }
  for (const tree of layout.trees) {
    const root = data.byId.get(tree.id);
    entries.push({ kind: "chain", tree, sortLevel: root.level, sortName: root.name });
  }
  entries.sort(
    (a, b) => a.sortLevel - b.sortLevel || a.sortName.localeCompare(b.sortName),
  );

  const grid = el("div", { class: "pill-grid" });
  for (const e of entries) {
    if (e.kind === "feat") grid.appendChild(renderPill(e.feat));
    else grid.appendChild(renderChainPill(e.tree, data));
  }

  return el("div", { class: "group-body" }, grid);
}

// Build a chain layout for a group of feat IDs. A "chain tree" exists in the
// layout only when a root has at least one descendant inside the same group.
// Solo roots with no in-group children are emitted as standalone.
//
// Multi-parent note: a feat with multiple OR parents (e.g., Traditional
// Resistances under 4 dragonbloods) intentionally appears under EACH
// parent's tree. The visited Set is per-traversal — a cycle guard, not a
// global de-dupe. By definition only group-roots become standalone, and
// group-roots have no in-group parent, so they never collide with
// descendants of other trees.
function buildGroupLayout(ids, data) {
  const inGroup = new Set(ids);
  const trees = [];
  const standalone = [];

  // Roots within this group = feats whose parent (if any) is NOT in the group.
  const groupRoots = [];
  for (const id of ids) {
    const parents = data.chains.parents.get(id) ?? new Set();
    let hasInGroupParent = false;
    for (const p of parents) {
      if (inGroup.has(p)) {
        hasInGroupParent = true;
        break;
      }
    }
    if (!hasInGroupParent) groupRoots.push(id);
  }

  // Sort roots by level then name for stable rendering.
  groupRoots.sort((a, b) => {
    const fa = data.byId.get(a);
    const fb = data.byId.get(b);
    return fa.level - fb.level || fa.name.localeCompare(fb.name);
  });

  // Walk down children (only those in the group). Per-traversal `visited`
  // guards against accidental cycles in malformed DAGs while still letting
  // the same descendant be re-emitted under different roots.
  function buildNode(id, visited) {
    const next = new Set(visited);
    next.add(id);
    const childIds = [
      ...(data.chains.children.get(id) ?? new Set()),
    ]
      .filter((c) => inGroup.has(c) && !next.has(c))
      .sort((a, b) => {
        const fa = data.byId.get(a);
        const fb = data.byId.get(b);
        return fa.level - fb.level || fa.name.localeCompare(fb.name);
      });
    return {
      id,
      children: childIds.map((c) => buildNode(c, next)),
    };
  }

  for (const rootId of groupRoots) {
    const node = buildNode(rootId, new Set());
    if (node.children.length > 0) trees.push(node);
    else standalone.push(rootId);
  }

  return { trees, standalone };
}


function sectionShell(type, total, body) {
  // Default state: General + Skill open; everything else closed. Overridden
  // by localStorage for sections the user has explicitly toggled.
  const fallback = type === "General" || type === "Skill";
  const open = getSectionOpen(type, fallback);
  const details = el(
    "details",
    { class: "feat-section", dataset: { type }, open },
    el(
      "summary",
      {},
      el("span", {}, type),
      el(
        "span",
        { class: "feat-section__counts", dataset: { type } },
        countsHtml(0, total),
      ),
    ),
    el("div", { class: "feat-section__body" }, body),
  );
  // Persist on every toggle. Generic by name, so renamed/added section
  // types just work without code changes.
  details.addEventListener("toggle", () => {
    setSectionOpen(type, details.open);
  });
  return details;
}

function countsHtml(selected, total) {
  const span = document.createDocumentFragment();
  const sel = el("b", {}, String(selected));
  span.append(sel, ` selected · ${total.toLocaleString()} total`);
  return span;
}

function refreshSelection(container, build, data) {
  // Update pill aria-pressed where state diverges.
  for (const pill of container.querySelectorAll(
    '.pill[data-action="toggle"]',
  )) {
    const id = pill.dataset.featId;
    const want = build.has(id);
    const have = pill.getAttribute("aria-pressed") === "true";
    if (want !== have) setPillSelected(pill, want);
  }
}

function refreshLocks(container, build, data, autoBuild) {
  // Treat auto-applied classfeatures as owned for prereq checks.
  const owned = autoBuild && autoBuild.size > 0
    ? new Set([...build, ...autoBuild.keys()])
    : build;
  for (const pill of container.querySelectorAll('.pill[data-action="toggle"]')) {
    const id = pill.dataset.featId;
    const feat = data.byId.get(id);
    if (!feat) continue;
    const locked = !build.has(id) && isLocked(feat, owned, data.byId);
    const have = pill.classList.contains("is-locked");
    if (locked !== have) setPillLocked(pill, locked, feat.prereq_text);
  }
}

function refreshVisibility(container, filters, query, data) {
  const visible = visibleIdSet(filters, query, data);
  for (const pill of container.querySelectorAll('.pill[data-action="toggle"]')) {
    let want;
    if (pill.classList.contains("pill--chain")) {
      // Chain pills represent multiple feats stacked into one DOM element.
      // Stay visible if ANY member matches the search/filter set —
      // otherwise children like "Startling Appearance (Vigilante)" inside
      // a chain rooted at "Vigilante Dedication" would silently disappear
      // when the user searches "startling".
      const ids = (pill.dataset.chainIds ?? "").split("|").filter(Boolean);
      want = !ids.some((id) => visible.has(id));
    } else {
      want = !visible.has(pill.dataset.featId);
    }
    const have = pill.classList.contains("is-hidden");
    if (want !== have) setPillHidden(pill, want);
  }
  // Hide subgroups + sections whose pills are all hidden.
  for (const sub of container.querySelectorAll(".subgroup")) {
    const anyVisible = sub.querySelector('.pill:not(.is-hidden)');
    sub.classList.toggle("is-hidden", !anyVisible);
  }
  for (const sec of container.querySelectorAll(".feat-section")) {
    const anyVisible = sec.querySelector('.pill:not(.is-hidden)');
    sec.classList.toggle("is-hidden", !anyVisible);
  }
}

function refreshCounts(container, build, data) {
  for (const counts of container.querySelectorAll(".feat-section__counts")) {
    const type = counts.dataset.type;
    if (type === "FreeFeats") continue; // owned by refreshFreeFeats
    const ids = data.byType.get(type) ?? [];
    let n = 0;
    for (const id of ids) if (build.has(id)) n++;
    clearChildren(counts);
    counts.append(countsHtml(n, ids.length));
  }
}

function refreshFreeFeats(containerOrSection, data, autoBuild) {
  // Accept either the wrapping container or the section element itself, so
  // callers can hand us whichever is convenient.
  const section =
    containerOrSection?.dataset?.type === "FreeFeats"
      ? containerOrSection
      : containerOrSection?.querySelector('.feat-section[data-type="FreeFeats"]');
  if (!section) return;
  const empty = !autoBuild || autoBuild.size === 0;
  section.style.display = empty ? "none" : "";
  const body = section.querySelector(".feat-section__body");
  const counts = section.querySelector(".feat-section__counts");
  if (empty) {
    if (body) clearChildren(body);
    if (counts) counts.textContent = "0 auto-applied";
    return;
  }
  // Group by walker-derived bucket — autoBuild is Map<id, bucket> where the
  // bucket label is the canonical class for the source-component the walker
  // assigned (see js/state.js#deriveCanonicalBucket). Falls back to feat.class
  // (when the walker resolved no bucket) and finally "Other". Trailing "Other"
  // appended last. Render via the shared renderTypeGroup helper so the visual
  // structure mirrors Build Summary's per-type sections. Ancestry items are
  // conglomerated into a single "Ancestries" bucket regardless of which
  // specific ancestry root landed — the per-class "Halfling" / "Elf" /etc.
  // headers fragment the section visually for what's a single concept.
  if (body) {
    clearChildren(body);
    const byBucket = new Map();
    for (const [id, bucket] of autoBuild) {
      const cf = data.byId.get(id);
      if (!cf) continue;
      const key = cf.type === "Ancestry"
        ? "Ancestries"
        : (bucket ?? cf.class ?? "Other");
      if (!byBucket.has(key)) byBucket.set(key, []);
      byBucket.get(key).push(cf);
    }
    const sortedKeys = [...byBucket.keys()].sort((a, b) => {
      if (a === "Other") return 1;
      if (b === "Other") return -1;
      return a.localeCompare(b);
    });
    for (const bucket of sortedKeys) {
      const list = byBucket.get(bucket)
        .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
      const pills = list.map((cf) => renderPill(cf, { selected: true, auto: true }));
      body.appendChild(renderTypeGroup(bucket, pills, { bucket }));
    }
  }
  if (counts) counts.textContent = `${autoBuild.size} auto-applied`;
}
