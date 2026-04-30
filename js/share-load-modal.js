// Modal asking the user how to handle a build "incoming" that would
// overwrite the current build. Used for two flows:
//   1. A #b/<code> share link arrived at boot.
//   2. The user picked a different profile from the dropdown.
//
// In both cases we offer:
//   • Save current as profile…  (prompts for a name, then loads incoming)
//   • Replace current             (loads incoming, drops current)
//   • Cancel                       (keeps current, ignores incoming)
//
// In the share-link case we also offer:
//   • Load a saved profile instead…  (lets the user switch to any saved
//     profile in place of accepting the shared build)
//
// Resolves to one of:
//   { action: "save",        name: string }
//   { action: "replace" }
//   { action: "loadProfile", profileId: string }
//   { action: "cancel" }

import { el } from "./util/dom.js";

export function askLoadStrategy({
  title = "Loaded a shared build",
  currentSize,
  incomingSize,
  incomingLabel = "the shared link",
  profiles = [],
}) {
  return new Promise((resolve) => {
    const dialog = el("dialog", {
      class: "share-load-dialog",
      "aria-labelledby": "share-load-title",
    });

    const onResolve = (result) => {
      cleanup();
      resolve(result);
    };

    const saveBtn = el(
      "button",
      {
        class: "share-load-dialog__btn share-load-dialog__btn--primary",
        type: "button",
        onclick: () => {
          const name = window.prompt(
            "Name this profile to save your current build:",
            `Build ${new Date().toLocaleDateString()}`,
          );
          if (name == null) return; // user cancelled the inner prompt — stay open
          onResolve({ action: "save", name });
        },
      },
      el("span", { class: "share-load-dialog__btn-title" }, "Save current as profile"),
      el(
        "span",
        { class: "share-load-dialog__btn-sub" },
        `Stash your current ${currentSize}-feat build under a name, then load ${incomingLabel}.`,
      ),
    );

    const replaceBtn = el(
      "button",
      {
        class: "share-load-dialog__btn share-load-dialog__btn--danger",
        type: "button",
        onclick: () => onResolve({ action: "replace" }),
      },
      el("span", { class: "share-load-dialog__btn-title" }, "Replace current"),
      el(
        "span",
        { class: "share-load-dialog__btn-sub" },
        `Discard your current build and load ${incomingLabel}.`,
      ),
    );

    const cancelBtn = el(
      "button",
      {
        class: "share-load-dialog__btn share-load-dialog__btn--ghost",
        type: "button",
        onclick: () => onResolve({ action: "cancel" }),
      },
      el("span", { class: "share-load-dialog__btn-title" }, "Cancel"),
      el(
        "span",
        { class: "share-load-dialog__btn-sub" },
        `Keep your current build. Ignore ${incomingLabel}.`,
      ),
    );

    const choices = el(
      "div",
      { class: "share-load-dialog__choices" },
      saveBtn,
      replaceBtn,
    );

    // Optional: load a saved profile instead of the incoming build.
    if (profiles && profiles.length > 0) {
      const profileSelect = el(
        "select",
        {
          class: "share-load-dialog__profile-select",
          "aria-label": "Pick a saved profile to load",
        },
        el("option", { value: "" }, "— pick a saved profile —"),
        ...profiles.map((p) =>
          el(
            "option",
            { value: p.id },
            `${p.name} (${p.build.length} feats)`,
          ),
        ),
      );
      const loadProfileBtn = el(
        "button",
        {
          class: "share-load-dialog__btn share-load-dialog__btn--secondary",
          type: "button",
          disabled: true,
          onclick: () => {
            const id = profileSelect.value;
            if (!id) return;
            onResolve({ action: "loadProfile", profileId: id });
          },
        },
        el(
          "span",
          { class: "share-load-dialog__btn-title" },
          "Load saved profile instead…",
        ),
        el(
          "span",
          { class: "share-load-dialog__btn-sub" },
          "Pick a saved profile to load in place of the incoming build.",
        ),
        profileSelect,
      );
      profileSelect.addEventListener("click", (e) => e.stopPropagation());
      profileSelect.addEventListener("change", () => {
        loadProfileBtn.disabled = profileSelect.value === "";
      });
      // Keep the select usable without triggering the surrounding button.
      profileSelect.addEventListener("mousedown", (e) => e.stopPropagation());
      choices.appendChild(loadProfileBtn);
    }

    choices.appendChild(cancelBtn);

    const closeX = el(
      "button",
      {
        class: "share-load-dialog__close",
        type: "button",
        "aria-label": "Cancel",
        onclick: () => onResolve({ action: "cancel" }),
      },
      "✕",
    );

    dialog.append(
      el(
        "div",
        { class: "share-load-dialog__head" },
        el(
          "h2",
          { class: "share-load-dialog__title", id: "share-load-title" },
          title,
        ),
        closeX,
      ),
      el(
        "p",
        { class: "share-load-dialog__body" },
        `You already have ${currentSize} feat${currentSize === 1 ? "" : "s"} in your build. ${capitalize(incomingLabel)} has ${incomingSize} feat${incomingSize === 1 ? "" : "s"}. What should I do?`,
      ),
      choices,
    );

    document.body.appendChild(dialog);
    dialog.showModal();

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      onResolve({ action: "cancel" });
    });

    function cleanup() {
      if (dialog.open) dialog.close();
      dialog.remove();
    }
  });
}

function capitalize(s) {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}
