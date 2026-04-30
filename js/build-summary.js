import { el, clearChildren } from "./util/dom.js";
import { store, subscribe, clearBuild } from "./state.js";
import { renderPill } from "./pill.js";
import { openDetail } from "./detail.js";
import { showToast } from "./toast.js";
import { getSectionOpen, setSectionOpen } from "./section-state.js";

const STATE_KEY = "BuildSummary";

// Collapsible build summary: total + per-type counts. Expanded shows the
// owned feats grouped by type, each rendered as a (read-only) pill.

export function renderBuildSummary(parent, data) {
  const summary = el(
    "details",
    { class: "build-summary", open: getSectionOpen(STATE_KEY, false) },
    el(
      "summary",
      { class: "build-summary__head" },
      el(
        "span",
        { class: "build-summary__title" },
        "Build summary — ",
        el("b", { class: "build-summary__count" }, "0"),
        " feats",
      ),
      el(
        "span",
        { class: "build-summary__breakdown" },
        "",
      ),
      el(
        "button",
        {
          class: "build-summary__clear",
          type: "button",
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClear();
          },
        },
        "Clear",
      ),
    ),
    el("div", { class: "build-summary__body" }),
  );

  parent.appendChild(summary);

  // Persist expand/collapse the same way feat-grid sections do.
  summary.addEventListener("toggle", () => {
    setSectionOpen(STATE_KEY, summary.open);
  });

  // Click delegation: pill ⓘ button opens the detail modal.
  summary.addEventListener("click", (e) => {
    const expand = e.target.closest('[data-action="expand"]');
    if (!expand) return;
    e.preventDefault();
    e.stopPropagation();
    const id = expand.dataset.featId;
    const f = data.byId.get(id);
    if (f) openDetail(f);
  });

  const headCount = summary.querySelector(".build-summary__count");
  const headBreakdown = summary.querySelector(".build-summary__breakdown");
  const body = summary.querySelector(".build-summary__body");
  const clearBtn = summary.querySelector(".build-summary__clear");

  function refresh() {
    const ids = [...store.build];
    headCount.textContent = String(ids.length);
    clearBtn.disabled = ids.length === 0;

    if (ids.length === 0) {
      headBreakdown.textContent = "";
      clearChildren(body);
      body.appendChild(
        el(
          "p",
          { class: "build-summary__empty" },
          "Your build is empty. Use the roller above or click pills below to add feats.",
        ),
      );
      return;
    }

    // Group by type for breakdown + body listing.
    const byType = new Map();
    for (const id of ids) {
      const f = data.byId.get(id);
      if (!f) continue;
      const key = f.type;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(f);
    }

    // Header breakdown: "Class 4 · Skill 3 · …" plus a muted "+N free feats"
    // suffix when classfeatures have been auto-pulled by chain.
    const parts = data.typeOrder
      .filter((t) => byType.has(t))
      .map((t) => `${t} ${byType.get(t).length}`);
    const autoCount = store.autoBuild?.size ?? 0;
    let breakdownText = parts.join(" · ");
    if (autoCount > 0) {
      breakdownText += `${parts.length ? "  ·  " : ""}+ ${autoCount} free feat${autoCount === 1 ? "" : "s"}`;
    }
    headBreakdown.textContent = breakdownText;

    // Body: per-type sub-lists with pills.
    clearChildren(body);
    for (const t of data.typeOrder) {
      const list = byType.get(t);
      if (!list?.length) continue;
      const pills = list
        .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
        .map((f) => renderPill(f, { selected: true }));
      body.appendChild(renderTypeGroup(t, pills, { type: t }));
    }
  }

  function onClear() {
    if (store.build.size === 0) return;
    if (
      !window.confirm(
        `Clear all ${store.build.size} feats from your build? This can't be undone.`,
      )
    ) {
      return;
    }
    clearBuild();
    showToast("Build cleared");
  }

  subscribe("build", refresh);
  subscribe("autoBuild", refresh);
  // Picks change → pill display labels (formatted with chosen choice values)
  // need a refresh so "Terrain Stalker" becomes "Terrain Stalker (Rubble)".
  subscribe("picks", refresh);
  refresh();
  return summary;
}

// Shared group-render helper. Used by build-summary's per-type buckets
// AND by Free Feats' per-class buckets in grid.js — single source of truth
// for the .build-summary__group DOM shape.
export function renderTypeGroup(label, pills, extraDataset = {}) {
  return el(
    "div",
    { class: "build-summary__group", dataset: extraDataset },
    el("h4", { class: "build-summary__group-title" }, `${label} (${pills.length})`),
    el("div", { class: "build-summary__pills" }, pills),
  );
}
