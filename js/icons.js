// Action-cost SVG glyph rendering. References the inline sprite injected at boot.

const ACTION_TO_ID = {
  one: "a-1",
  two: "a-2",
  three: "a-3",
  reaction: "a-r",
  free: "a-f",
  passive: "a-p",
  varies: "a-v",
};

const ACTION_LABEL = {
  one: "1 action",
  two: "2 actions",
  three: "3 actions",
  reaction: "Reaction",
  free: "Free action",
  passive: "Passive",
  varies: "Variable actions",
};

export function renderActionGlyph(actions) {
  const id = ACTION_TO_ID[actions] ?? "a-v";
  const label = ACTION_LABEL[actions] ?? actions;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "action-glyph");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("role", "img");

  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#${id}`);
  svg.appendChild(use);
  return svg;
}

export function actionLabel(actions) {
  return ACTION_LABEL[actions] ?? actions;
}
