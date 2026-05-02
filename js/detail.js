import { el, clearChildren } from "./util/dom.js";
import { renderActionGlyph, actionLabel } from "./icons.js";
import { store, subscribe, toggleBuild, computeAutoBuildFor, KNOWN_CLASSES, setPick } from "./state.js";
import { checkAndCascade } from "./picks-modal.js";
import { requirementsSatisfied } from "./selectors.js";
import { showToast } from "./toast.js";
import { renderPill } from "./pill.js";
import { renderTypeGroup } from "./build-summary.js";

// Single dialog reused across feats. Maintains a navigation history so users
// can drill into prereq feats and pop back. Renders an Add/Remove button in
// the header that toggles the displayed feat in the build (with cascade-
// orphan removal handled in state.js).

let dialog = null;
let data = null;
let history = []; // stack of feat objects; top of stack is the currently-shown feat
let unsub = null; // unsubscribe handle for store.build subscription while open

export function initDetail(d) {
  data = d;
}

export function openDetail(feat) {
  history = [feat];
  ensureDialog();
  renderCurrent();
  if (!dialog.open) dialog.showModal();
  // Keep the modal in sync with build mutations done from inside it.
  unsub?.();
  unsub = subscribeToBuild();
}

export function closeDetail() {
  if (dialog?.open) dialog.close();
  history = [];
  unsub?.();
  unsub = null;
}

function ensureDialog() {
  if (dialog) return dialog;
  dialog = el("dialog", {
    id: "detail-dialog",
    class: "detail-dialog",
    "aria-labelledby": "detail-name",
  });
  document.body.appendChild(dialog);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    history = [];
    unsub?.();
    unsub = null;
  });
  // Click delegation: inline prereq links.
  dialog.addEventListener("click", (e) => {
    const link = e.target.closest("[data-feat-link]");
    if (link) {
      e.preventDefault();
      const target = data?.byId.get(link.dataset.featLink);
      if (target) navigateTo(target);
    }
  });
  return dialog;
}

function navigateTo(feat) {
  history.push(feat);
  renderCurrent();
}

function goBack() {
  if (history.length > 1) {
    history.pop();
    renderCurrent();
  }
}

function subscribeToBuild() {
  // Re-render when build changes so the Add/Remove button label and the
  // locked-notice link reflect new state.
  return subscribe("build", () => renderCurrent());
}

function renderCurrent() {
  if (!dialog || history.length === 0) return;
  const feat = history[history.length - 1];
  const inBuild = store.build.has(feat.id);
  const ownedSet = (() => {
    if (!data) return store.build;
    const auto = store.autoBuild;
    return auto && auto.size > 0
      ? new Set([...store.build, ...auto.keys()])
      : store.build;
  })();
  const canAdd = data ? requirementsSatisfied(feat, ownedSet, data.byId) : true;
  // The OR-picker can unblock a feat that's locked solely because of an
  // unsatisfied `requires.any`. In that case the Add button stays — but
  // it's disabled until the user picks. Compute that branch explicitly.
  // Pickers (OR-prereq + multi-class) are now optional at commit time —
  // user can Add without picking, and a non-dismissible cascade modal
  // surfaces the unresolved choice immediately after. Add stays enabled.
  // Lock semantics still apply when the feat genuinely can't be added
  // (e.g. unsatisfied requires.all that no picker would unblock).
  const orPickable = !inBuild && !canAdd && data
    ? canBeUnlockedByOrPick(feat, ownedSet, data.byId)
    : false;
  const isLockedAdd = !inBuild && !canAdd && !orPickable;

  clearChildren(dialog);

  // --- Header ---
  const head = el("div", { class: "detail-dialog__head" });

  if (history.length > 1) {
    head.appendChild(
      el(
        "button",
        {
          class: "detail-dialog__back",
          type: "button",
          "aria-label": "Go back",
          title: "Back",
          onclick: goBack,
        },
        "← Back",
      ),
    );
  }

  head.appendChild(
    el(
      "h2",
      { class: "detail-dialog__name", id: "detail-name" },
      renderActionGlyph(feat.actions),
      " ",
      feat.name,
    ),
  );

  // Add/Remove button (or "Need: <link>" when locked).
  let addBtn = null;
  if (isLockedAdd) {
    head.appendChild(renderLockedNotice(feat));
  } else {
    addBtn = el(
      "button",
      {
        class:
          "detail-dialog__action " +
          (inBuild
            ? "detail-dialog__action--remove"
            : "detail-dialog__action--add"),
        type: "button",
        onclick: () => {
          const chosenOr = dialog.querySelector("[data-or-chosen]")?.value || "";
          const chosenClass = dialog.querySelector("[data-class-chosen]")?.value || "";
          onToggleFromModal(feat, chosenOr, chosenClass);
        },
        "aria-label": inBuild ? "Remove from build" : "Add to build",
      },
      inBuild ? "− Remove" : "+ Add",
    );
    head.appendChild(addBtn);
  }

  head.appendChild(
    el(
      "button",
      {
        class: "detail-dialog__close",
        type: "button",
        "aria-label": "Close",
        onclick: () => dialog.close(),
      },
      "✕",
    ),
  );

  // --- Body (shared with bloom cards via renderFeatBody) ---

  const body = el(
    "div",
    { class: "detail-dialog__body" },
    ...renderFeatBody(feat, { interactive: true }),
  );

  // Pickers don't gate the Add button anymore — they're convenience
  // surfaces. Unresolved picks cascade after Add via the picks-modal.

  dialog.append(head, body);
}

// Shared feat title (action glyph + name). Used by detail modal head and by
// bloom popup cards so titles look identical.
export function renderFeatTitle(feat) {
  return el(
    "h2",
    { class: "detail-dialog__name" },
    renderActionGlyph(feat.actions),
    " ",
    feat.name,
  );
}

// Shared feat body builder. Returns an array of DOM elements (meta, traits,
// prereq, description, source). Caller wraps them in whatever container they
// need (modal body, bloom card content, etc).
//
// `interactive` (default true) controls prereq link behavior:
//   true  → prereq feat names are clickable links that swap the detail modal
//   false → same visual style, but clicks are stopped (and AoN clicks are
//           also stopped from bubbling so they don't trigger card pick)
// `suppressPickers` (default false) skips the OR / class picker UI plus
// the preview slot + hidden inputs. Used by the picks-cascade modal which
// owns its own option buttons and doesn't want a redundant picker inside
// the feat card.
export function renderFeatBody(feat, { interactive = true, suppressPickers = false } = {}) {
  const meta = el(
    "div",
    { class: "detail-meta", dataset: { rarity: feat.rarity } },
    el("span", { class: "detail-meta__rarity" }, feat.rarity),
    el("span", {}, `${feat.type} feat`),
    feat.class ? el("span", {}, feat.class) : null,
    el("span", {}, `Level ${feat.level}`),
    el("span", {}, actionLabel(feat.actions)),
  );

  const traitChips = (feat.traits ?? []).length
    ? el(
        "div",
        { class: "detail-traits" },
        feat.traits.map((t) =>
          el("span", { class: "detail-traits__trait" }, t),
        ),
      )
    : null;

  const prereq = feat.prereq_text
    ? el(
        "p",
        { class: "detail-prereq" },
        el("strong", {}, "Prerequisites: "),
        linkifyPrereqText(feat, { interactive }),
      )
    : null;

  // Read-only "Choices" info section. Cards never render interactive
  // pickers — all picking happens via the cascading picks-modal. Cards
  // just SHOW what choices a feat will ask for. Recursion is automatic:
  // when an option card (in the cascade footer) is rendered via this
  // same renderFeatBody, it also displays its own choices section, so
  // the user sees the chained sequence of upcoming prompts.
  const choicesInfo = renderChoicesInfo(feat);

  // Read-only "Auto-applies" section: walker projection of what would
  // land in autoBuild if the user added THIS feat to their build right
  // now. Filters out anything already owned. Drops when there's nothing
  // to add (already owned, or terminal feat with no chain).
  const autoAppliesInfo = renderAutoAppliesInfo(feat);

  const description = el("div", { class: "detail-description" });
  description.innerHTML =
    feat.description || "<p><em>No description.</em></p>";

  // Foundry tags pre-Remaster items via publication.remaster=false; the
  // build lifts that into feat.remaster. Surface a "(Legacy)" suffix so the
  // user can tell when a feat predates Player Core / ORC and may have a
  // dropped or renamed prereq target. Default-true records show no suffix.
  const sourceLabel = feat.source || "Source unknown";
  const legacyLabel =
    feat.remaster === false ? `${sourceLabel} (Legacy)` : sourceLabel;

  const source = el(
    "div",
    { class: "detail-source" },
    el("span", { dataset: { remaster: String(feat.remaster !== false) } }, legacyLabel),
    feat.url
      ? el(
          "a",
          {
            href: feat.url,
            target: "_blank",
            rel: "external noopener",
            // In non-interactive contexts (bloom cards) keep AoN openable but
            // stop the click from bubbling to the card's pick handler.
            onclick: interactive ? undefined : (e) => e.stopPropagation(),
          },
          "Open on Archives of Nethys ↗",
        )
      : null,
  );

  return [
    meta,
    traitChips,
    prereq,
    choicesInfo,
    autoAppliesInfo,
    description,
    source,
  ].filter(Boolean);
}

// Render a read-only "Auto-applies" projection for a candidate feat.
// Uses the SAME pill+bucket-group rendering pipeline as the Free Feats
// section in the main grid (see js/grid.js#refreshFreeFeats) — pills are
// rarity-tinted with glow, grouped by walker-derived bucket, conglomerated
// "Ancestries" header. Read-only: pills carry `auto: true` so they have
// no toggle action; the wrapping section stops click propagation so a
// pill ⓘ click doesn't bubble up to a bloom-card pick handler.
function renderAutoAppliesInfo(feat) {
  if (!data) return null;
  if (store.build.has(feat.id)) return null;
  if (store.autoBuild.has(feat.id)) return null;
  const hypothetical = new Set(store.build);
  hypothetical.add(feat.id);
  const projected = computeAutoBuildFor(hypothetical);

  // Bucketing rule mirrored from refreshFreeFeats so the visual is
  // identical to the live Free Feats panel.
  const byBucket = new Map();
  for (const [id, bucket] of projected) {
    if (id === feat.id) continue;
    if (store.build.has(id)) continue;
    if (store.autoBuild.has(id)) continue;
    const cf = data.byId.get(id);
    if (!cf) continue;
    const key = cf.type === "Ancestry"
      ? "Ancestries"
      : (bucket ?? cf.class ?? "Other");
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(cf);
  }
  if (byBucket.size === 0) return null;

  const sortedKeys = [...byBucket.keys()].sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  const groups = sortedKeys.map((bucket) => {
    const list = byBucket.get(bucket)
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    const pills = list.map((cf) => renderPill(cf, { selected: true, auto: true }));
    return renderTypeGroup(bucket, pills, { bucket });
  });

  const wrapper = el(
    "div",
    { class: "detail-auto-applies" },
    el(
      "p",
      { class: "detail-auto-applies__heading" },
      el("strong", {}, "Auto-applies:"),
    ),
    el("div", { class: "detail-auto-applies__groups" }, groups),
  );
  // Stop pill clicks from bubbling to the bloom-card / picks-cascade card
  // pick handler when this section is rendered inside such a button. Also
  // wire the pill's ⓘ button so the user can drill into auto-applied feats
  // from any card surface. Inside the detail modal we navigateTo (push
  // history); elsewhere (bloom / cascade) we openDetail (fresh modal stack
  // on top of the bloom or cascade dialog).
  wrapper.addEventListener("click", (e) => {
    e.stopPropagation();
    const expand = e.target.closest('[data-action="expand"]');
    if (!expand) return;
    e.preventDefault();
    const target = data?.byId.get(expand.dataset.featId);
    if (!target) return;
    if (dialog && dialog.open) navigateTo(target);
    else openDetail(target);
  });
  return wrapper;
}

// Read-only display of a feat's Foundry ChoiceSet rules. Each choice
// renders as a list item: prompt, then either the resolved value (with
// an inline [edit] affordance) or a preview of available options.
// Returns null when the feat has no choices.
function renderChoicesInfo(feat) {
  const choices = feat?.choices ?? [];
  if (choices.length === 0) return null;
  const tr = data?.translate || ((k) => k);
  const featPicks = store.picks?.get?.(feat.id);
  const cs = featPicks?.choiceSets ?? {};

  const items = choices.map((choice) => {
    const promptText = tr(choice.prompt) || "Choose one";
    const opts = choice.options ?? [];
    const resolvedValue = cs[choice.id];

    // Resolved → show the chosen value + [edit] button. Editing clears
    // the pick and re-invokes the cascade so the user can re-select
    // (works for freetext and option-list picks alike).
    if (resolvedValue) {
      let resolvedLabel;
      if (choice.kind === "freetext") {
        resolvedLabel = choice.labelPrefix ? `${choice.labelPrefix} (${resolvedValue})` : String(resolvedValue);
      } else {
        const opt = opts.find((o) => o.value === resolvedValue);
        resolvedLabel = opt ? (tr(opt.label) || opt.value) : String(resolvedValue);
      }
      const editBtn = el(
        "button",
        {
          class: "detail-choices__edit",
          type: "button",
          title: "Clear and re-pick",
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            setPick(feat.id, "choiceSet", { id: choice.id, value: null });
            // Cascade re-fires the just-cleared pick. setTimeout 0 lets
            // the click event finish first so the modal stack is clean.
            if (data) setTimeout(() => checkAndCascade(data), 0);
          },
        },
        "edit",
      );
      return el(
        "li",
        { class: "detail-choices__item" },
        el("strong", { class: "detail-choices__prompt" }, promptText + ": "),
        el("span", { class: "detail-choices__resolved" }, resolvedLabel),
        " ",
        editBtn,
      );
    }

    // Unresolved — preview available options (existing behavior).
    let optsLine;
    if (choice.kind === "freetext") {
      optsLine = el("em", {}, "type your own value");
    } else if (opts.length === 0) {
      optsLine = el("em", {}, "no options available");
    } else if (opts.some((o) => o.yieldsFeat) && opts.length > 8) {
      optsLine = el("span", { class: "detail-choices__summary" },
        `${opts.length} feats — picked via the choice menu`);
    } else {
      const labels = opts.slice(0, 8).map((o) => tr(o.label) || o.value);
      const tail = opts.length > 8 ? `, … (+${opts.length - 8} more)` : "";
      optsLine = el("span", { class: "detail-choices__opts" }, labels.join(" · ") + tail);
    }
    return el(
      "li",
      { class: "detail-choices__item" },
      el("strong", { class: "detail-choices__prompt" }, promptText + ": "),
      optsLine,
    );
  });
  return el(
    "div",
    { class: "detail-choices" },
    el("p", { class: "detail-choices__heading" },
      el("strong", {}, "Choices:")),
    el("ul", { class: "detail-choices__list" }, items),
  );
}

// Render the "Free feats this will pull in" projection. Computes the
// hypothetical autoBuild assuming the user adds `feat.id` (plus the chosen
// OR-prereq slug, if any) and lists newly-pulled feats grouped by class.
// Returns null when there's nothing to project (already owned, or no
// auto-pulls would happen).
function renderFreeFeatPreview(feat, chosenOrSlug, chosenClassSlug) {
  if (!data) return null;
  // Skip feats the user already owns — preview would just re-list items
  // they already see in Free Feats / Build Summary.
  if (store.build.has(feat.id)) return null;
  if (store.autoBuild.has(feat.id)) return null;

  const hypothetical = new Set(store.build);
  hypothetical.add(feat.id);
  if (chosenOrSlug) hypothetical.add(chosenOrSlug);
  if (chosenClassSlug) hypothetical.add(chosenClassSlug);

  const projected = computeAutoBuildFor(hypothetical);
  // newAdds = items the walker would add ONLY because of this feat (and
  // the chosen OR-slug). Filter out anything already owned in the user's
  // current build OR current autoBuild — otherwise the preview leaks the
  // user's full free-feat list, not the per-feat delta.
  const newAdds = new Map(); // id -> bucket from projected walker
  for (const [id, bucket] of projected) {
    if (id === feat.id) continue;
    if (store.build.has(id)) continue;
    if (store.autoBuild.has(id)) continue;
    newAdds.set(id, bucket);
  }
  // The chosen picker slugs (OR-prereq + class) are committed to `build` on
  // Pick, not pulled by the walker. To the user they ARE "free feats" of
  // this choice — surface them explicitly when not already owned. Bucket
  // alongside walker neighbors (or fall back to the slug-derived class).
  for (const chosen of [chosenOrSlug, chosenClassSlug]) {
    if (!chosen || chosen === feat.id) continue;
    if (store.build.has(chosen) || store.autoBuild.has(chosen)) continue;
    if (newAdds.has(chosen)) continue;
    const cFeat = data.byId.get(chosen);
    const cBucket = projected.get(chosen) ?? cFeat?.class ?? null;
    newAdds.set(chosen, cBucket);
  }
  if (newAdds.size === 0) return null;

  // Group by walker-derived bucket with feat.class fallback and trailing
  // Other. Ancestry items collapse into a single "Ancestries" header,
  // matching the Free Feats section's conglomeration rule (js/grid.js).
  const byBucket = new Map();
  for (const [id, bucket] of newAdds) {
    const f = data.byId.get(id);
    if (!f) continue;
    const key = f.type === "Ancestry"
      ? "Ancestries"
      : (bucket ?? f.class ?? "Other");
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(f);
  }
  const sortedKeys = [...byBucket.keys()].sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  // Render via the same pill + type-group machinery as the live Auto-
  // applies section above (renderAutoAppliesInfo) and the Free Feats
  // panel — single source of truth for "list of pulled-in feats", so
  // pills get the familiar rarity tint, ⓘ inspect button, and grouping.
  const groups = sortedKeys.map((bucket) => {
    const pills = byBucket.get(bucket)
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
      .map((f) => renderPill(f, { auto: true }));
    return renderTypeGroup(bucket, pills, { bucket });
  });

  const wrapper = el(
    "div",
    { class: "detail-free-preview" },
    el(
      "p",
      { class: "detail-free-preview__heading" },
      el("strong", {}, "Free feats this will pull in:"),
    ),
    ...groups,
  );
  // Same click-handling pattern as renderAutoAppliesInfo: stop pill body
  // clicks from bubbling to any wrapping bloom / cascade card, and route
  // the pill's ⓘ button to navigate (if we're inside the detail dialog)
  // or open a fresh detail modal (if rendered elsewhere).
  wrapper.addEventListener("click", (e) => {
    e.stopPropagation();
    const expand = e.target.closest('[data-action="expand"]');
    if (!expand) return;
    e.preventDefault();
    const target = data?.byId.get(expand.dataset.featId);
    if (!target) return;
    if (dialog && dialog.open) navigateTo(target);
    else openDetail(target);
  });
  return wrapper;
}

// Replace feat-name occurrences in `prereq_text` with rarity-tinted mini
// pills. In interactive contexts (the detail modal) they're real anchors
// that swap the modal contents via the dialog's click delegation. In
// non-interactive contexts (bloom cards) they're rendered as visible spans
// with click stopped so the surrounding card pick action still works.
function linkifyPrereqText(feat, { interactive = true } = {}) {
  const text = feat.prereq_text || "";
  if (!data || !text) return document.createTextNode(text);

  const slugs = [...(feat.requires?.all ?? []), ...(feat.requires?.any ?? [])];
  // Build candidate entries from both the canonical name AND a "bare" name
  // (parenthesized suffix stripped) so prereq_text "Startling Appearance"
  // can match slugs named "Startling Appearance (Fleshwarp)" or "(Vigilante)".
  const stripParens = (n) => n.replace(/\s*\([^)]*\)\s*$/i, "").trim();
  const named = [];
  for (const slug of slugs) {
    const name = data.byId.get(slug)?.name;
    if (!name) continue;
    named.push({ slug, name, key: name.toLowerCase() });
    const bare = stripParens(name);
    if (bare && bare.toLowerCase() !== name.toLowerCase()) {
      named.push({ slug, name: bare, key: bare.toLowerCase() });
    }
  }
  if (!named.length) return document.createTextNode(text);

  // Group all entries that share the same lookup key, longest-first so
  // "Startling Appearance (Vigilante)" wins over the bare "Startling Appearance"
  // when prereq_text actually used the disambiguated form.
  const byKey = new Map(); // key -> [{slug, name}]
  for (const e of named) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push({ slug: e.slug, name: e.name });
  }
  const keys = [...byKey.keys()].sort((a, b) => b.length - a.length);
  const escaped = keys.map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const re = new RegExp(`(${escaped.join("|")})`, "gi");

  const renderPill = (slug, label) => {
    const linkedFeat = data.byId.get(slug);
    const tag = interactive ? "a" : "span";
    const attrs = interactive
      ? {
          class: "prereq-link",
          href: "#",
          dataset: {
            featLink: slug,
            rarity: linkedFeat?.rarity ?? "common",
          },
          title: `View ${linkedFeat?.name ?? label}`,
        }
      : {
          class: "prereq-link prereq-link--static",
          dataset: { rarity: linkedFeat?.rarity ?? "common" },
          onclick: (e) => e.stopPropagation(),
        };
    return el(tag, attrs, label);
  };

  const frag = document.createDocumentFragment();
  let idx = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > idx) frag.append(text.slice(idx, m.index));
    const matched = m[0];
    const matches = byKey.get(matched.toLowerCase());
    if (matches && matches.length) {
      // One slug → single pill. Multiple slugs sharing a bare name → render
      // each as its own pill, joined by " or ", so "Startling Appearance"
      // expands inline to "Startling Appearance (Fleshwarp) or (Vigilante)".
      if (matches.length === 1) {
        frag.append(renderPill(matches[0].slug, matched));
      } else {
        // Sort for stable display.
        const sorted = [...matches].sort((a, b) =>
          (data.byId.get(a.slug)?.name ?? "").localeCompare(
            data.byId.get(b.slug)?.name ?? "",
          ),
        );
        sorted.forEach((m2, i) => {
          if (i > 0) frag.append(" or ");
          // Use the actual disambiguated feat name as the pill label so the
          // user sees "(Fleshwarp)" / "(Vigilante)" explicitly.
          frag.append(renderPill(m2.slug, data.byId.get(m2.slug)?.name ?? m2.name));
        });
      }
    } else {
      frag.append(matched);
    }
    idx = m.index + matched.length;
  }
  if (idx < text.length) frag.append(text.slice(idx));
  return frag;
}

function renderLockedNotice(feat) {
  // Find the missing prereqs. Single missing → clickable link. Multiple
  // missing → "see below" pointing the user at the full prereq paragraph
  // rendered just under the header (which linkifies every option).
  if (!data) return el("span", { class: "detail-dialog__locked" }, "🔒 Locked");

  const allMissing = (feat.requires?.all ?? []).filter(
    (id) => !store.build.has(id),
  );
  const anyMissing = (feat.requires?.any ?? []).filter(
    (id) => !store.build.has(id),
  );
  const totalMissing = allMissing.length + anyMissing.length;

  if (totalMissing > 1) {
    return el(
      "div",
      { class: "detail-dialog__locked" },
      el("span", { class: "detail-dialog__locked-pin" }, "🔒"),
      "Need: see below",
    );
  }

  const firstMissing = allMissing[0] ?? anyMissing[0];
  if (firstMissing && data.byId.get(firstMissing)) {
    const target = data.byId.get(firstMissing);
    return el(
      "div",
      { class: "detail-dialog__locked" },
      el("span", { class: "detail-dialog__locked-pin" }, "🔒"),
      "Need: ",
      el(
        "a",
        {
          class: "prereq-link",
          href: "#",
          dataset: { featLink: target.id, rarity: target.rarity },
          title: `Open ${target.name}`,
        },
        target.name,
      ),
      " →",
    );
  }

  // Wildcard or non-feat prereq.
  const wildcard = feat.requires?.anyClassFeat || feat.requires?.anyTrait;
  return el(
    "span",
    { class: "detail-dialog__locked" },
    "🔒 ",
    wildcard
      ? `Needs any ${feat.requires.anyClassFeat ? feat.requires.anyClassFeat + " feat" : feat.requires.anyTrait + " feat"}`
      : "Locked",
  );
}

function onToggleFromModal(feat, chosenOrSlug = "", chosenClassSlug = "") {
  const wasIn = store.build.has(feat.id);
  const orphans = toggleBuild(feat.id);
  // When ADDING with picker choices: record the choices in store.picks
  // (not store.build). Walker reads picks during DFS and pulls the chosen
  // chain into autoBuild. Removing the parent feat clears its picks
  // automatically (state.js#removeFromBuild). Choices are persisted to
  // localStorage; share-codes don't carry them — receivers re-resolve via
  // the cascade modal on import.
  if (!wasIn) {
    if (chosenClassSlug && data?.byId.get(chosenClassSlug)) {
      setPick(feat.id, "class", chosenClassSlug);
    }
    if (chosenOrSlug && data?.byId.get(chosenOrSlug)) {
      setPick(feat.id, "or", chosenOrSlug);
    }
    // Surface any picker choices the user didn't make on the card.
    if (data) setTimeout(() => checkAndCascade(data), 0);
  }
  if (wasIn && orphans.length > 0) {
    const names = orphans.map((id) => data.byId.get(id)?.name).filter(Boolean);
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
}

// Returns true when the only blocker on `feat` is an unsatisfied
// `requires.any` AND there's at least one valid pickable option. Used by
// the modal to keep the Add button visible (disabled-until-pick) instead
// of showing the locked notice.
// Returns true when the feat carries 2+ class traits (resolvable to known
// PF2e classes) AND none of the candidate `<class>-dedication` slugs is
// owned yet. Drives the multi-class picker on the card. Works the same
// for any N >= 2 (e.g. Haft Striker Stance has fighter+ranger+rogue).
function hasClassPick(feat, ownedSet) {
  const traits = (feat.traits ?? [])
    .map((t) => String(t).toLowerCase())
    .filter((t) => KNOWN_CLASSES.has(t));
  if (traits.length < 2) return false;
  // If at least one dedication is already owned, the class branch is
  // already satisfied — no pick needed.
  for (const t of traits) {
    if (ownedSet.has(`${t}-dedication`)) return false;
  }
  // At least two distinct dedication candidates must resolve to real feats.
  let resolvable = 0;
  for (const t of traits) {
    if (data?.byId.get(`${t}-dedication`)) resolvable++;
    if (resolvable >= 2) return true;
  }
  return false;
}

function canBeUnlockedByOrPick(feat, ownedSet, byId) {
  const any = feat.requires?.any ?? [];
  if (any.length === 0) return false;
  const validOptions = any.filter((id) => byId.get(id));
  if (validOptions.length === 0) return false;
  // Try satisfying with each candidate — if any one makes the feat
  // satisfiable, the feat is OR-pickable.
  for (const opt of validOptions) {
    const trial = new Set(ownedSet);
    trial.add(opt);
    if (requirementsSatisfied(feat, trial, byId)) return true;
  }
  return false;
}
