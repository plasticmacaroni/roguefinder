// Per-section collapse-state persistence. Stored as a generic name->bool map
// keyed by section display name (so new types added later auto-persist
// without code changes).

const KEY = "feat-chooser:sections";

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function write(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private browsing / quota — ignore */
  }
}

export function getSectionOpen(name, fallback = false) {
  const state = read();
  return Object.prototype.hasOwnProperty.call(state, name)
    ? Boolean(state[name])
    : fallback;
}

export function setSectionOpen(name, open) {
  const state = read();
  state[name] = Boolean(open);
  write(state);
}

export function setManySections(map) {
  const state = read();
  for (const [name, open] of Object.entries(map)) {
    state[name] = Boolean(open);
  }
  write(state);
}
