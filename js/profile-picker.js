import { el, clearChildren } from "./util/dom.js";
import { store, subscribe } from "./state.js";
import {
  listProfiles,
  createProfile,
  saveBuildToProfile,
  deleteProfile,
  getActiveProfileId,
  setActiveProfileId,
  renameProfile,
} from "./profiles.js";
import { askLoadStrategy } from "./share-load-modal.js";
import { showToast } from "./toast.js";

// A small profile picker that mounts inside the build-summary header.
// Shows a select with all saved profiles, an active marker, and three
// actions: Save (overwrites the active profile or creates a new one if
// none active), Save As (always creates), Delete (removes active).

export function renderProfilePicker(parent) {
  const select = el("select", {
    class: "profile-picker__select",
    "aria-label": "Switch profile",
  });

  const saveBtn = el(
    "button",
    {
      class: "profile-picker__btn",
      type: "button",
      title: "Save the current build to the active profile",
      onclick: () => onSave(),
    },
    "Save",
  );
  const saveAsBtn = el(
    "button",
    {
      class: "profile-picker__btn",
      type: "button",
      title: "Save the current build as a NEW profile",
      onclick: () => onSaveAs(),
    },
    "Save as New",
  );
  const renameBtn = el(
    "button",
    {
      class: "profile-picker__btn",
      type: "button",
      title: "Rename the active profile",
      onclick: () => onRename(),
    },
    "Rename",
  );
  const deleteBtn = el(
    "button",
    {
      class: "profile-picker__btn profile-picker__btn--danger",
      type: "button",
      title: "Delete the active profile (current build is preserved)",
      onclick: () => onDelete(),
    },
    "Delete",
  );

  select.addEventListener("change", () => onSwitch(select.value));

  const wrap = el(
    "div",
    {
      class: "profile-picker",
      // Stop summary-toggle clicks from collapsing the panel when buttons
      // are pressed.
      onclick: (e) => e.stopPropagation(),
    },
    el("span", { class: "profile-picker__label" }, "Profile:"),
    select,
    saveBtn,
    saveAsBtn,
    renameBtn,
    deleteBtn,
  );
  parent.appendChild(wrap);

  function refresh() {
    const profiles = listProfiles();
    const activeId = getActiveProfileId();
    clearChildren(select);
    select.appendChild(
      el("option", { value: "" }, "— No profile —"),
    );
    for (const p of profiles) {
      select.appendChild(
        el(
          "option",
          { value: p.id },
          `${p.name} (${p.build.length})${p.id === activeId ? " ✓" : ""}`,
        ),
      );
    }
    select.value = activeId ?? "";
    deleteBtn.disabled = !activeId;
    renameBtn.disabled = !activeId;
  }

  async function onSwitch(id) {
    if (!id) {
      setActiveProfileId(null);
      refresh();
      return;
    }
    const profiles = listProfiles();
    const p = profiles.find((x) => x.id === id);
    if (!p) {
      refresh();
      return;
    }

    // Empty current build OR switching to the active profile: just load.
    if (store.build.size === 0 || id === getActiveProfileId()) {
      store.build = new Set(p.build);
      setActiveProfileId(id);
      showToast(`Loaded profile '${p.name}' (${p.build.length} feats)`);
      refresh();
      return;
    }

    const choice = await askLoadStrategy({
      title: `Switch to profile '${p.name}'?`,
      currentSize: store.build.size,
      incomingSize: p.build.length,
      incomingLabel: `profile '${p.name}'`,
      // No 'load saved profile' option here — the user already picked one.
      profiles: [],
    });

    if (choice.action === "cancel") {
      refresh();
      return;
    }

    if (choice.action === "save") {
      const saved = createProfile(choice.name, store.build);
      showToast(
        `Saved current as '${saved.name}' (${saved.build.length} feats)`,
      );
    }

    // Replace OR save-then-load: same downstream action.
    store.build = new Set(p.build);
    setActiveProfileId(id);
    showToast(`Loaded profile '${p.name}' (${p.build.length} feats)`);
    refresh();
  }

  function onSave() {
    const activeId = getActiveProfileId();
    if (!activeId) {
      onSaveAs();
      return;
    }
    const updated = saveBuildToProfile(activeId, store.build);
    if (updated) {
      showToast(`Saved '${updated.name}' (${updated.build.length} feats)`);
    }
    refresh();
  }

  function onSaveAs() {
    const name = window.prompt(
      "Name this profile:",
      `Build ${new Date().toLocaleDateString()}`,
    );
    if (name == null) return;
    const p = createProfile(name, store.build);
    setActiveProfileId(p.id);
    showToast(`Created profile '${p.name}'`);
    refresh();
  }

  function onRename() {
    const activeId = getActiveProfileId();
    if (!activeId) return;
    const profiles = listProfiles();
    const p = profiles.find((x) => x.id === activeId);
    if (!p) return;
    const name = window.prompt("Rename profile:", p.name);
    if (name == null) return;
    renameProfile(activeId, name);
    refresh();
  }

  function onDelete() {
    const activeId = getActiveProfileId();
    if (!activeId) return;
    const profiles = listProfiles();
    const p = profiles.find((x) => x.id === activeId);
    if (!p) return;
    if (
      !window.confirm(
        `Delete profile '${p.name}'? Your current build is NOT cleared.`,
      )
    ) {
      return;
    }
    deleteProfile(activeId);
    showToast(`Deleted profile '${p.name}'`);
    refresh();
  }

  // Listen for cross-tab profile changes via storage events.
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith("feat-chooser:profile")) refresh();
  });
  // Refresh once whenever the build changes (so counts update).
  subscribe("build", refresh);

  refresh();
  return wrap;
}
