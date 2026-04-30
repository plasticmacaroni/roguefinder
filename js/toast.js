import { el } from "./util/dom.js";

let container = null;

function ensureContainer() {
  if (container) return container;
  container = el("div", { class: "toast-stack", "aria-live": "polite" });
  document.body.appendChild(container);
  return container;
}

export function showToast(text, { duration = 3500 } = {}) {
  const c = ensureContainer();
  const t = el("div", { class: "toast", role: "status" }, text);
  c.appendChild(t);
  requestAnimationFrame(() => t.classList.add("toast--visible"));
  setTimeout(() => {
    t.classList.remove("toast--visible");
    setTimeout(() => t.remove(), 200);
  }, duration);
}
