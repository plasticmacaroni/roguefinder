import { el, qs, qsa } from "./util/dom.js";
import { setManySections } from "./section-state.js";

// Floating action cluster bottom-right: a back-to-top button and a
// collapse-all / expand-all toggle. The old sticky chip bar at the top of
// the page has been removed in favor of this minimal floating affordance.

export function renderFloatingActions() {
  const collapseBtn = el(
    "button",
    {
      class: "fab fab--collapse",
      type: "button",
      "aria-label": "Collapse or expand all sections",
      title: "Collapse all",
    },
    el("span", { class: "fab__icon" }, "⇕"),
  );

  collapseBtn.addEventListener("click", () => toggleAllSections(collapseBtn));

  const topBtn = el(
    "button",
    {
      class: "fab fab--top",
      type: "button",
      "aria-label": "Back to top",
      title: "Back to top",
      onclick: () => window.scrollTo({ top: 0, behavior: "smooth" }),
    },
    "↑",
  );

  const cluster = el(
    "div",
    { class: "floating-actions", "aria-label": "Page actions" },
    collapseBtn,
    topBtn,
  );
  document.body.appendChild(cluster);

  // Show the back-to-top button only after scrolling past the first section.
  const reveal = () => {
    topBtn.classList.toggle("visible", window.scrollY > 600);
  };
  window.addEventListener("scroll", reveal, { passive: true });
  reveal();
}

function toggleAllSections(toggleBtn) {
  const sections = qsa(".feat-section");
  if (!sections.length) return;
  const openCount = sections.filter((s) => s.hasAttribute("open")).length;
  const shouldExpand = openCount < sections.length / 2;

  // Persist all-at-once so we don't fire 7 separate localStorage writes.
  const persistMap = {};
  for (const s of sections) {
    if (shouldExpand) s.setAttribute("open", "");
    else s.removeAttribute("open");
    const name = s.dataset.type;
    if (name) persistMap[name] = shouldExpand;
  }
  setManySections(persistMap);

  toggleBtn.title = shouldExpand ? "Collapse all" : "Expand all";
  toggleBtn.querySelector(".fab__icon").textContent = shouldExpand ? "⇕" : "⇕";
  toggleBtn.classList.toggle("fab--all-open", shouldExpand);
}

