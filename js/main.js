// Capture and CLEAR the share-code hash immediately, before any await, so
// the user's URL bar normalizes to the site address before the page even
// finishes loading. We re-apply the captured code after data loads.
const _pendingShareCode = (() => {
  const h = location.hash || "";
  if (!h.startsWith("#b/")) return null;
  const code = h.slice(3);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return code || null;
})();

import { loadFeats } from "./data.js";
import { store, subscribe, toggleBuild, setStateData } from "./state.js";
import { renderGrid, setGridHandlers, renderFreeFeats } from "./grid.js";
import { renderFloatingActions } from "./nav.js";
import { renderFilters } from "./filters.js";
import { renderSearchBar } from "./search.js";
import { renderRoller } from "./roller.js";
import { renderBuildSummary } from "./build-summary.js";
import { renderProfilePicker } from "./profile-picker.js";
import { openDetail, initDetail } from "./detail.js";
import { openChainPopover } from "./chain-popover.js";
import { showToast } from "./toast.js";
import { saveBuild, saveFilters, saveQuery, savePicks } from "./persist.js";
import { checkAndCascade } from "./picks-modal.js";
import { applyShareCode } from "./router.js";
import { askLoadStrategy } from "./share-load-modal.js";
import {
  createProfile,
  setActiveProfileId,
  listProfiles,
  getProfile,
} from "./profiles.js";
import { el, qs } from "./util/dom.js";

const app = document.getElementById("app");

try {
  app.replaceChildren(el("p", { class: "build-count" }, "Loading feats…"));
  const data = await loadFeats();
  setStateData(data);
  initDetail(data);

  // If we captured a share code at boot, apply it now that we have data.
  // When the user already has a non-empty build, ask before overwriting.
  if (_pendingShareCode) {
    const sharedBuild = applyShareCode(_pendingShareCode, data.feats);
    if (sharedBuild) {
      await applySharedBuildWithConfirmation(sharedBuild);
    }
  }

  setGridHandlers({
    toggle: (id) => toggleAndToast(id, data),
    expand: (id) => {
      const feat = data.byId.get(id);
      if (feat) openDetail(feat);
    },
    chainPopover: (anchor) => {
      const ids = anchor.dataset.chainIds.split("|");
      openChainPopover(anchor, ids, data, (feat) => openDetail(feat));
    },
  });

  app.replaceChildren();
  renderProfilePicker(app); // top-level: always visible above filters

  // Filters (Types + Levels) and the Roller share one outer frame so they
  // read as a single "build-this-spin" deck. Order inside is preserved:
  // filters first (Types then Levels), then the roller.
  const playDeck = el("section", {
    class: "play-deck",
    "aria-label": "Filters and roller",
  });
  app.appendChild(playDeck);
  renderFilters(playDeck);
  renderRoller(playDeck, data);

  renderSearchBar(app); // LAYOUT-02: search below roller
  renderBuildSummary(app, data);
  // Free Feats sits directly under the build summary so the auto-applied
  // classfeatures read as an extension of the user's build.
  renderFreeFeats(app, data);

  renderGrid(app, data, { store, subscribe });

  renderFloatingActions();

  // Persistence: write through every change (debounced inside persist.js).
  subscribe("build", saveBuild);
  subscribe("filters", saveFilters);
  subscribe("query", saveQuery);
  subscribe("picks", savePicks);

  globalThis.__feats = data;
  globalThis.__store = store;

  // After data + persisted state are loaded, surface any unresolved picks
  // (multi-class / requires.any feats with no recorded resolution). Modal
  // cascade is non-dismissible — user must pick one path per outstanding
  // feat. Fires once at boot; future bloom/detail commits also call
  // checkAndCascade for the just-added feat.
  setTimeout(() => checkAndCascade(data), 0);
} catch (err) {
  console.error(err);
  app.replaceChildren(
    el(
      "div",
      { class: "build-count", style: "color: salmon" },
      "Failed to load feats. Check the console.",
    ),
  );
}

async function applySharedBuildWithConfirmation(sharedBuild) {
  const sharedSize = sharedBuild.size;
  const currentSize = store.build.size;

  // Empty current build: nothing to lose, load straight in.
  if (currentSize === 0) {
    store.build = sharedBuild;
    setActiveProfileId(null);
    showToast(
      `Loaded shared build: ${sharedSize} feat${sharedSize === 1 ? "" : "s"}`,
    );
    return;
  }

  const choice = await askLoadStrategy({
    title: "Loaded a shared build",
    currentSize,
    incomingSize: sharedSize,
    incomingLabel: "the shared link",
    profiles: listProfiles(),
  });

  if (choice.action === "cancel") {
    showToast("Shared build ignored — your current build is unchanged.");
    return;
  }

  if (choice.action === "save") {
    const profile = createProfile(choice.name, store.build);
    showToast(
      `Saved current as '${profile.name}' (${profile.build.length} feats)`,
    );
    setActiveProfileId(null);
    store.build = sharedBuild;
    showToast(
      `Loaded shared build: ${sharedSize} feat${sharedSize === 1 ? "" : "s"}`,
    );
    return;
  }

  if (choice.action === "loadProfile") {
    const p = getProfile(choice.profileId);
    if (!p) {
      showToast("That profile is gone — falling back to the shared build.");
      store.build = sharedBuild;
      setActiveProfileId(null);
      return;
    }
    store.build = new Set(p.build);
    setActiveProfileId(p.id);
    showToast(`Loaded profile '${p.name}' (${p.build.length} feats)`);
    return;
  }

  // Replace.
  setActiveProfileId(null);
  store.build = sharedBuild;
  showToast(
    `Replaced with shared build: ${sharedSize} feat${sharedSize === 1 ? "" : "s"}`,
  );
}

function toggleAndToast(id, data) {
  const wasIn = store.build.has(id);
  const orphans = toggleBuild(id);
  const feat = data.byId.get(id);
  const name = feat?.name ?? id;
  if (wasIn && orphans.length > 0) {
    const names = orphans.map((o) => data.byId.get(o)?.name).filter(Boolean);
    showToast(
      `Removed ${name} — also pulled ${names.length} dependent ${
        names.length === 1 ? "feat" : "feats"
      }: ${names.join(", ")}`,
    );
  } else if (wasIn) {
    showToast(`Removed ${name}`);
  } else {
    showToast(`Added ${name}`);
    // Surface any unresolved pickers (multi-class / requires.any) on the
    // just-added feat. Without this the picker wouldn't appear until next
    // reload — the boot detector would catch it but a live click would not.
    setTimeout(() => checkAndCascade(data), 0);
  }
}
