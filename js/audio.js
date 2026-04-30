// Web Audio API plumbing. ONE AudioContext, one decoded AudioBuffer per
// sound, fresh BufferSource per play. Scheduling uses currentTime, never
// setTimeout — iOS Safari silently drops setTimeout-scheduled audio.
//
// Mute state persists to localStorage so users keep the same preference
// across visits. (Phase 5 owns persistence broadly; this is a small,
// self-contained slice that lives where the audio code does.)

const SOUNDS = {
  ding:  { url: "./assets/audio/ding.mp3",  gain: 0.32 }, // ~ -10 dB; ticks fast.
  kazoo: { url: "./assets/audio/kazoo.mp3", gain: 0.85 }, // celebration: prominent.
  wow:   { url: "./assets/audio/wow.mp3",   gain: 1.05 }, // uncommon: clearly audible.
};

const MUTE_KEY = "feat-chooser:muted";

let ctx = null;
let masterGain = null;
let supported = true;
let muted = readMuted();
const buffers = new Map(); // name -> AudioBuffer
const listeners = new Set();

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMuted(v) {
  try {
    if (v) localStorage.setItem(MUTE_KEY, "1");
    else localStorage.removeItem(MUTE_KEY);
  } catch {
    /* private browsing / quota — ignore */
  }
}

function ensureContext() {
  if (ctx || !supported) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) {
    supported = false;
    return null;
  }
  try {
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);
  } catch (err) {
    supported = false;
    ctx = null;
    console.warn("Audio context init failed:", err);
  }
  return ctx;
}

async function loadOne(name) {
  if (buffers.has(name) || !ctx) return buffers.get(name) ?? null;
  const cfg = SOUNDS[name];
  if (!cfg) return null;
  try {
    const res = await fetch(cfg.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    buffers.set(name, buf);
    return buf;
  } catch (err) {
    console.warn(`Audio buffer load failed for ${name}:`, err);
    return null;
  }
}

// Call from inside a user gesture (Spin click). Resumes context + decodes
// every registered sound. Safe to call repeatedly.
export async function unlockAudio() {
  if (!supported) return false;
  ensureContext();
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended") await ctx.resume();
    await Promise.all(Object.keys(SOUNDS).map(loadOne));
    return true;
  } catch (err) {
    console.warn("Audio unlock failed:", err);
    return false;
  }
}

function playSound(name, offsetSeconds = 0) {
  if (!supported || !ctx || muted) return;
  const buf = buffers.get(name);
  if (!buf) return;
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const perGain = ctx.createGain();
    perGain.gain.value = SOUNDS[name].gain;
    src.connect(perGain).connect(masterGain);
    const t = Math.max(ctx.currentTime + offsetSeconds, ctx.currentTime);
    src.start(t);
  } catch (err) {
    console.warn(`playSound ${name} failed:`, err);
  }
}

export const playTick  = (off = 0) => playSound("ding",  off);
export const playKazoo = (off = 0) => playSound("kazoo", off);
export const playWow   = (off = 0) => playSound("wow",   off);

export function setMuted(v) {
  muted = Boolean(v);
  writeMuted(muted);
  if (masterGain && ctx) {
    masterGain.gain.setValueAtTime(muted ? 0 : 1, ctx.currentTime);
  }
  for (const fn of listeners) fn(muted);
}

export function isMuted() {
  return muted;
}

export function onMuteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isAudioSupported() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  return Boolean(Ctor) && supported;
}

// --- Choice popup music ---------------------------------------------------
//
// Two streamed tracks tied to the picking surfaces (bloom popup +
// picks-cascade modal):
//   results.mp3       — short stinger that fires once when the popup opens.
//   shopmusic.mpga    — loops as background while a choice is in-flight.
//
// Streamed via `<audio>` rather than Web Audio buffer so the multi-MB
// loop track doesn't decode to tens of MB of PCM in memory. Mute state
// piggybacks on the existing setMuted; we mirror it onto the elements'
// muted property and listen for changes.

const RESULTS_URL = "./assets/audio/results.mp3";
const SHOP_URL = "./assets/audio/shopmusic.mpga";

let resultsEl = null;
let shopEl = null;
let choiceConsumers = 0; // refcount: bloom + picks-cascade can stack.

function ensureChoiceAudio() {
  if (!resultsEl) {
    resultsEl = new Audio(RESULTS_URL);
    resultsEl.preload = "auto";
    resultsEl.volume = 0.85;
    resultsEl.muted = muted;
  }
  if (!shopEl) {
    shopEl = new Audio(SHOP_URL);
    shopEl.preload = "auto";
    shopEl.loop = true;
    shopEl.volume = 0.45; // softer — it's background.
    shopEl.muted = muted;
  }
}

// Called when a choice popup opens. First open plays the results stinger
// once and starts the shop loop. Subsequent opens (e.g. picks-cascade
// stacking on the bloom flow) just bump the refcount so the music
// keeps playing without restart.
export function startChoiceMusic() {
  ensureChoiceAudio();
  choiceConsumers++;
  if (choiceConsumers > 1) return;
  // Play stinger once. Promises rejected on autoplay restriction get
  // swallowed — the popup is opened from a user gesture so it should work.
  try {
    resultsEl.currentTime = 0;
    const p = resultsEl.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
  try {
    shopEl.currentTime = 0;
    const p = shopEl.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

// Called when a choice popup closes. Stops the shop loop only when the
// last consumer leaves.
export function stopChoiceMusic() {
  if (choiceConsumers <= 0) return;
  choiceConsumers--;
  if (choiceConsumers > 0) return;
  if (shopEl) {
    try { shopEl.pause(); shopEl.currentTime = 0; } catch {}
  }
  if (resultsEl) {
    // Stinger usually finishes on its own; pause defensively.
    try { resultsEl.pause(); } catch {}
  }
}

// Mirror the existing mute state onto the choice-music elements.
onMuteChange((m) => {
  if (resultsEl) resultsEl.muted = m;
  if (shopEl) shopEl.muted = m;
});
