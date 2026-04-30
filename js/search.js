import { el } from "./util/dom.js";
import { debounce } from "./util/debounce.js";
import { setQuery, store } from "./state.js";

export function renderSearchBar(parent) {
  const input = el("input", {
    class: "search-bar__input",
    type: "search",
    placeholder: "Search feats by name…",
    "aria-label": "Search feats by name",
    autocomplete: "off",
    spellcheck: "false",
    value: store.query ?? "", // restore from persisted state on render
  });

  const clearBtn = el(
    "button",
    {
      class: "search-bar__clear",
      type: "button",
      title: "Clear search",
      "aria-label": "Clear search",
    },
    "×",
  );

  const syncClearVisibility = () => {
    clearBtn.hidden = !input.value;
  };
  syncClearVisibility();

  const update = debounce((v) => setQuery(v), 80);
  input.addEventListener("input", () => {
    syncClearVisibility();
    update(input.value);
  });

  // ESC clears.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      input.value = "";
      syncClearVisibility();
      setQuery("");
      e.preventDefault();
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    syncClearVisibility();
    setQuery("");
    input.focus();
  });

  const bar = el(
    "div",
    { class: "search-bar" },
    el("span", { class: "search-bar__icon", "aria-hidden": "true" }, "⌕"),
    input,
    clearBtn,
  );
  parent.appendChild(bar);

  return { input };
}
