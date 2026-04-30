// Cascading non-dismissible modal for unresolved picker choices. When a
// build feat has multi-class traits or unsatisfied requires.any AND no
// matching slug is in build/autoBuild AND no entry exists in store.picks,
// the user has to resolve it before the page can be used. Modal cycles
// through every unresolved feat in sequence; user picks one path per
// modal, picks are committed via setPick.
//
// Layout reuses the bloom selection popup's full-screen scrollable shell
// (`bloom-dialog`) so the parent feat shows as a familiar bloom-card and
// the user has plenty of room to read description / traits / preview.
// Option buttons live in the footer; clicking one resolves and advances.

import { el, clearChildren } from "./util/dom.js";
import { store, setPick, KNOWN_CLASSES, computeAutoBuildFor } from "./state.js";
import { renderFeatTitle, renderFeatBody } from "./detail.js";
import { startChoiceMusic, stopChoiceMusic } from "./audio.js";

// Detect every feat in `build` whose pickers haven't been resolved.
// Returns [{ featId, kind: "class"|"or", options: Array<{slug, name, level, rarity, label}> }]
// Multi-class is class kind. requires.any is or kind. A feat may produce
// up to two entries (one per kind) if BOTH need a pick.
export function findUnresolvedPicks(build, picks, autoBuild, byId) {
  const out = [];
  if (!byId) return out;
  const owned = new Set(build);
  if (autoBuild) {
    const ids = autoBuild instanceof Map ? autoBuild.keys() : autoBuild;
    for (const id of ids) owned.add(id);
  }
  // Scan build AND autoBuild — feats pulled in via picks.choiceSets land
  // in autoBuild; if they have their own ChoiceSets we still need to
  // surface them. This is what makes recursive chained picking work
  // (Ancestral Paragon → Animal Senses → pick a sense).
  const scanIds = new Set(build);
  if (autoBuild) {
    const ids = autoBuild instanceof Map ? autoBuild.keys() : autoBuild;
    for (const id of ids) scanIds.add(id);
  }
  for (const featId of scanIds) {
    const f = byId.get(featId);
    if (!f) continue;
    const featPicks = picks?.get(featId) ?? {};
    // --- multi-class branch ---
    const classTraits = (f.traits ?? [])
      .map((t) => String(t).toLowerCase())
      .filter((t) => KNOWN_CLASSES.has(t));
    if (classTraits.length >= 2 && !featPicks.class) {
      const candidates = classTraits
        .map((t) => `${t}-dedication`)
        .filter((slug) => byId.get(slug));
      const alreadyResolved = candidates.some((slug) => owned.has(slug));
      if (!alreadyResolved && candidates.length >= 2) {
        out.push({
          featId,
          kind: "class",
          parentName: f.name,
          options: candidates.map((slug) => {
            const opt = byId.get(slug);
            const trait = slug.replace(/-dedication$/, "");
            return {
              slug,
              name: opt.name,
              level: opt.level,
              rarity: opt.rarity,
              label: trait.charAt(0).toUpperCase() + trait.slice(1),
            };
          }),
        });
      }
    }
    // --- requires.any branch ---
    const anyOptions = (f.requires?.any ?? []).filter((slug) => byId.get(slug));
    if (anyOptions.length >= 2 && !featPicks.or) {
      const alreadyResolved = anyOptions.some((slug) => owned.has(slug));
      if (!alreadyResolved) {
        out.push({
          featId,
          kind: "or",
          parentName: f.name,
          options: anyOptions.map((slug) => {
            const opt = byId.get(slug);
            return {
              slug,
              name: opt.name,
              level: opt.level,
              rarity: opt.rarity,
              label: opt.name,
            };
          }),
        });
      }
    }
    // --- Foundry ChoiceSet branch ---
    // Each ChoiceSet rule on the feat (resolved at build time into
    // `feat.choices`) yields a separate entry in the cascade if no value
    // is recorded in picks[featId].choiceSets[choice.id].
    const choices = f.choices ?? [];
    const cs = featPicks.choiceSets ?? {};
    for (const choice of choices) {
      if (cs[choice.id]) continue; // resolved
      const opts = choice.options ?? [];
      if (opts.length === 0) continue; // nothing to pick
      // Skip when the user already owns one of the feat-yielding options
      // (treat as de-facto resolved — same convention as the class/or paths).
      const alreadyOwned = opts.some(
        (o) => o.yieldsFeat && owned.has(o.value),
      );
      if (alreadyOwned) continue;
      out.push({
        featId,
        kind: "choice",
        parentName: f.name,
        choice,
      });
    }
  }
  return out;
}

let cascadeActive = false;

export function presentPicksCascade(unresolved) {
  if (!unresolved || unresolved.length === 0) return Promise.resolve();
  if (cascadeActive) return Promise.resolve();
  cascadeActive = true;
  const queue = unresolved.slice();
  return new Promise((resolve) => {
    const next = () => {
      if (queue.length === 0) {
        cascadeActive = false;
        resolve();
        return;
      }
      const item = queue.shift();
      openOne(item, next);
    };
    next();
  });
}

function openOne(item, advance) {
  const { featId, kind, parentName, byId, translate } = item;
  const parentFeat = byId?.get(featId);

  // Full-screen dialog mirroring the bloom popup shell.
  const dialog = el("dialog", {
    class: "bloom-dialog picks-cascade-dialog",
    "aria-labelledby": "picks-cascade-title",
  });
  dialog.addEventListener("cancel", (e) => e.preventDefault());
  startChoiceMusic();

  // Heading + explanatory line. ChoiceSet rules use Foundry i18n keys for
  // their prompt; resolve via translate (with heuristic fallback baked in).
  const tr = typeof translate === "function" ? translate : (k) => k;
  let heading, why, optionsHeading;
  if (kind === "class") {
    heading = `Pick a class for ${parentName}`;
    why = `${parentName} carries traits for multiple classes — in PF2e a single feat can be taken by any of those classes, but each path leads to a different dedication and chain. Your pick decides which class chain auto-applies.`;
    optionsHeading = "Choose a class:";
  } else if (kind === "or") {
    heading = `Pick a prerequisite path for ${parentName}`;
    why = `${parentName} requires one of several prerequisite feats. Your pick decides which prerequisite chain auto-applies — the others stay out of your build.`;
    optionsHeading = "Choose a prerequisite:";
  } else if (kind === "choice") {
    const promptText = tr(item.choice.prompt) || `Pick a value for ${parentName}`;
    heading = `${promptText} — ${parentName}`;
    why = item.choice.options?.some((o) => o.yieldsFeat)
      ? `${parentName} grants you a feat from a filtered list. Pick one — only the chosen path's chain auto-applies.`
      : `${parentName} requires you to pick a value (Foundry ChoiceSet). Your pick is recorded alongside the feat and shown in the build summary.`;
    optionsHeading = optionsHeadingForChoice(item.choice, tr);
  }

  // Parent feat card — same renderer as bloom selection cards.
  const card = parentFeat ? buildPicksCard(parentFeat) : null;

  // Footer options. For class / or → existing simple option buttons.
  // For choice (Foundry ChoiceSet) → either feat-card option (yieldsFeat)
  // or simple option buttons (informational tags).
  let optionsContainer;
  if (kind === "choice") {
    optionsContainer = renderChoiceOptions(item, byId, tr, () => {
      dialog.close();
      dialog.remove();
      stopChoiceMusic();
      advance();
    });
  } else {
    const buttons = (item.options ?? []).map((opt) =>
      renderOptionButton({
        opt,
        featId,
        kind,
        byId,
        onPick: () => {
          setPick(featId, kind, opt.slug);
          dialog.close();
          dialog.remove();
          stopChoiceMusic();
          advance();
        },
      }),
    );
    optionsContainer = el("div", { class: "picks-cascade-options" }, buttons);
  }

  const scroll = el(
    "div",
    { class: "bloom-dialog__scroll" },
    el(
      "div",
      { class: "bloom-head" },
      el("h2", { id: "picks-cascade-title", class: "bloom-title" }, heading),
      el("p", { class: "bloom-sub" }, why),
    ),
    card ? el("div", { class: "bloom-card-row picks-cascade-card-row" }, card) : null,
    el(
      "div",
      { class: "picks-cascade-options-heading" },
      el("strong", {}, optionsHeading),
    ),
    optionsContainer,
  );

  dialog.append(scroll);
  document.body.appendChild(dialog);
  dialog.showModal();
}

function optionsHeadingForChoice(choice, tr) {
  // Best-effort heading text for the option grid section. Uses the prompt
  // when it's a recognizable label; otherwise generic.
  const opts = choice.options ?? [];
  if (opts.some((o) => o.yieldsFeat)) return "Choose a feat:";
  return "Choose one:";
}

// Render a list of options for a Foundry ChoiceSet pick. Two modes:
//   - yieldsFeat options → each rendered as a full feat card (same shape
//     as the parent card / bloom selection cards), clickable.
//   - tag options       → existing simple option buttons (per-row card).
function renderChoiceOptions(item, byId, tr, onAfterPick) {
  const { featId, choice } = item;
  const opts = choice.options ?? [];

  const commit = (value) => {
    setPick(featId, "choiceSet", { id: choice.id, value });
    onAfterPick();
  };

  if (opts.some((o) => o.yieldsFeat)) {
    // Feat-yielding choice — render each option as a clickable feat card.
    // Reuses the bloom selection card structure: same renderFeatBody output.
    const cards = opts
      .filter((o) => o.yieldsFeat)
      .map((opt) => {
        const f = byId.get(opt.value);
        if (!f) return null;
        return el(
          "button",
          {
            class: "bloom-card picks-cascade-option-card",
            type: "button",
            dataset: { rarity: f.rarity, featId: f.id },
            "aria-label": `Pick ${f.name}`,
            onclick: () => commit(opt.value),
          },
          renderFeatTitle(f),
          ...renderFeatBody(f, { interactive: false, suppressPickers: true }),
        );
      })
      .filter(Boolean);
    return el(
      "div",
      { class: "bloom-card-row picks-cascade-card-row picks-cascade-option-cards" },
      cards,
    );
  }

  // Tag-style options (skill, terrain, weapon-type, etc.)
  const buttons = opts.map((opt) =>
    el(
      "button",
      {
        class: "picks-cascade-option",
        type: "button",
        dataset: { rarity: opt.rarity ?? "common" },
        onclick: () => commit(opt.value),
      },
      el(
        "div",
        { class: "picks-cascade-option__head" },
        el("span", { class: "picks-cascade-option__label" }, tr(opt.label) || opt.value),
      ),
    ),
  );
  return el("div", { class: "picks-cascade-options" }, buttons);
}

// Build a bloom-style card for the parent feat. Reuses renderFeatTitle +
// renderFeatBody but suppresses the in-body picker (this modal owns the
// pick action via explicit option buttons in the footer).
function buildPicksCard(feat) {
  const title = renderFeatTitle(feat);
  const body = renderFeatBody(feat, { interactive: false, suppressPickers: true });
  return el(
    "article",
    {
      class: "bloom-card picks-cascade-card",
      dataset: { rarity: feat.rarity, featId: feat.id },
    },
    title,
    ...body,
  );
}

// Each option button: large, click-to-commit. Shows class/prereq label,
// the dedication/feat it pulls in, traits, and a preview of the chain
// that would land in autoBuild if this option is chosen.
function renderOptionButton({ opt, featId, kind, byId, onPick }) {
  const optFeat = byId?.get(opt.slug);
  const traits = optFeat?.traits?.length
    ? el(
        "div",
        { class: "picks-cascade-option__traits" },
        optFeat.traits.slice(0, 8).map((t) =>
          el("span", { class: "picks-cascade-option__trait" }, t),
        ),
      )
    : null;
  const preview = byId
    ? renderOptionPreview(opt.slug, featId, kind, byId)
    : null;

  return el(
    "button",
    {
      class: "picks-cascade-option",
      type: "button",
      dataset: { rarity: opt.rarity },
      onclick: onPick,
    },
    el(
      "div",
      { class: "picks-cascade-option__head" },
      el("span", { class: "picks-cascade-option__label" }, opt.label),
      el(
        "span",
        { class: "picks-cascade-option__meta" },
        `Level ${opt.level} · ${opt.rarity}`,
      ),
    ),
    el(
      "p",
      { class: "picks-cascade-option__sub" },
      `Auto-applies ${opt.name}${optFeat?.class ? ` (${optFeat.class})` : ""}.`,
    ),
    traits,
    preview,
  );
}

// Compute and render the chain that would land in autoBuild if this
// option were chosen. Filters out anything already in the user's
// build/autoBuild so the preview shows only the per-option delta.
function renderOptionPreview(chosenSlug, featId, kind, byId) {
  const hypotheticalBuild = new Set(store.build);
  hypotheticalBuild.add(featId);
  const hypotheticalPicks = new Map(store.picks);
  const cur = hypotheticalPicks.get(featId) ?? {};
  hypotheticalPicks.set(featId, { ...cur, [kind]: chosenSlug });

  const projected = computeAutoBuildFor(hypotheticalBuild, hypotheticalPicks, byId);

  const newAdds = [];
  for (const [id] of projected) {
    if (id === featId) continue;
    if (store.build.has(id)) continue;
    if (store.autoBuild.has(id)) continue;
    newAdds.push(id);
  }
  if (!store.build.has(chosenSlug) && !store.autoBuild.has(chosenSlug)
      && !newAdds.includes(chosenSlug)) {
    newAdds.unshift(chosenSlug);
  }
  if (newAdds.length === 0) return null;

  const items = newAdds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
    .slice(0, 12);

  return el(
    "div",
    { class: "picks-cascade-option__preview" },
    el("span", { class: "picks-cascade-option__preview-label" }, "Pulls in:"),
    el(
      "ul",
      { class: "picks-cascade-option__preview-list" },
      items.map((f) =>
        el(
          "li",
          { class: "picks-cascade-option__preview-item", dataset: { rarity: f.rarity } },
          f.name,
          el("span", { class: "picks-cascade-option__preview-level" }, ` (L${f.level})`),
        ),
      ),
    ),
  );
}

// Convenience wrapper — runs the detector against current store state and
// presents the cascade. Accepts either the full `data` object (preferred —
// gives us translate too) OR a bare `byId` map for backward compat.
export async function checkAndCascade(dataOrById) {
  const isFullData = dataOrById && typeof dataOrById === "object" && dataOrById.byId;
  const byId = isFullData ? dataOrById.byId : dataOrById;
  const translate = isFullData && typeof dataOrById.translate === "function"
    ? dataOrById.translate
    : (k) => k;
  // Loop until the detector returns nothing. Picking an option in one
  // wave may pull a new feat into autoBuild whose own ChoiceSets weren't
  // visible before — re-detect after each wave to catch those. Guards
  // against runaway by capping the wave count.
  for (let wave = 0; wave < 32; wave++) {
    const unresolved = findUnresolvedPicks(
      store.build, store.picks, store.autoBuild, byId,
    );
    if (unresolved.length === 0) return;
    for (const u of unresolved) {
      u.byId = byId;
      u.translate = translate;
    }
    await presentPicksCascade(unresolved);
  }
}
