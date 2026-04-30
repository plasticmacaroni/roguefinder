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

  const update = debounce((v) => setQuery(v), 80);
  input.addEventListener("input", () => update(input.value));

  // ESC clears.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      input.value = "";
      setQuery("");
      e.preventDefault();
    }
  });

  const bar = el(
    "div",
    { class: "search-bar" },
    el("span", { class: "search-bar__icon", "aria-hidden": "true" }, "⌕"),
    input,
  );
  parent.appendChild(bar);

  // If something else clears the query, reflect it.
  // (Light wiring; main.js handles deeper plumbing.)
  return { input };
}
