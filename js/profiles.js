// Named build profiles. Stored in localStorage as a list of
// { id, name, build: string[], created, updated } records. The "active"
// profile id (the one whose build is currently loaded into the store) is
// stored separately, so switching is a one-write operation.

const PROFILES_KEY = "feat-chooser:profiles";
const ACTIVE_KEY   = "feat-chooser:active-profile";

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

export function listProfiles() {
  const raw = safeRead(PROFILES_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeProfiles(list) {
  safeWrite(PROFILES_KEY, JSON.stringify(list));
}

export function getActiveProfileId() {
  return safeRead(ACTIVE_KEY);
}

export function setActiveProfileId(id) {
  if (id == null) safeWrite(ACTIVE_KEY, null);
  else safeWrite(ACTIVE_KEY, String(id));
}

function newId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Create a new profile from the given build (Set<string> or string[]).
// Returns the new profile record.
export function createProfile(name, build) {
  const list = listProfiles();
  const trimmedName = (name ?? "").trim() || "Untitled";
  const profile = {
    id: newId(),
    name: trimmedName,
    build: [...build],
    created: Date.now(),
    updated: Date.now(),
  };
  list.push(profile);
  writeProfiles(list);
  return profile;
}

// Overwrite the named profile's build (and update timestamp). No-op if the
// profile doesn't exist anymore.
export function saveBuildToProfile(id, build) {
  const list = listProfiles();
  const i = list.findIndex((p) => p.id === id);
  if (i === -1) return null;
  list[i].build = [...build];
  list[i].updated = Date.now();
  writeProfiles(list);
  return list[i];
}

export function renameProfile(id, name) {
  const list = listProfiles();
  const i = list.findIndex((p) => p.id === id);
  if (i === -1) return null;
  list[i].name = (name ?? "").trim() || "Untitled";
  list[i].updated = Date.now();
  writeProfiles(list);
  return list[i];
}

export function deleteProfile(id) {
  const list = listProfiles().filter((p) => p.id !== id);
  writeProfiles(list);
  if (getActiveProfileId() === id) setActiveProfileId(null);
}

export function getProfile(id) {
  return listProfiles().find((p) => p.id === id) ?? null;
}
