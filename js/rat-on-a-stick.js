import { dvdBounce } from "./vendor/dvd-bounce.mjs";

// Meme page orchestrator:
//   • A pool of 10 rat GIFs. Up to ACTIVE_COUNT fly across the screen at
//     once. Each picks a random angle, speed, and entry edge. When a gif
//     fully exits the viewport, it's removed and replaced by a different
//     gif from the pool — no duplicates on screen at any time.
//   • The center JPG pulses (CSS) and randomly cycles through CSS-filter
//     "effects" every ~3 s.
//   • Audio autoplays once the user dismisses the splash (browsers block
//     autoplay without a gesture, so the splash doubles as the unlock).

const POOL_SIZE = 10;
const POOL = Array.from({ length: POOL_SIZE }, (_, i) => `./assets/rat/gif-${i + 1}.gif`);
const ACTIVE_COUNT = 5;
const CENTER_EFFECT_MS = 3000;
const FLY_EFFECT_MS = 1500; // gifs cycle filters twice as often as center.
const FLY_RATE_MIN = 1;
const FLY_RATE_MAX = 5;

// Closeup background images (extensions vary, so they're listed verbatim).
// 22 files in assets/rat/closeups/.
const CLOSEUPS = [
  "./assets/rat/closeups/closeup-1.webp",
  "./assets/rat/closeups/closeup-2.webp",
  "./assets/rat/closeups/closeup-3.jpg",
  "./assets/rat/closeups/closeup-4.webp",
  "./assets/rat/closeups/closeup-5.jpg",
  "./assets/rat/closeups/closeup-6.jpg",
  "./assets/rat/closeups/closeup-7.jpg",
  "./assets/rat/closeups/closeup-8.png",
  "./assets/rat/closeups/closeup-9.jpg",
  "./assets/rat/closeups/closeup-10.jpg",
  "./assets/rat/closeups/closeup-11.webp",
  "./assets/rat/closeups/closeup-12.jpg",
  "./assets/rat/closeups/closeup-13.png",
  "./assets/rat/closeups/closeup-14.jpg",
  "./assets/rat/closeups/closeup-15.webp",
  "./assets/rat/closeups/closeup-16.jpg",
  "./assets/rat/closeups/closeup-17.jpg",
  "./assets/rat/closeups/closeup-18.jpg",
  "./assets/rat/closeups/closeup-19.jpg",
  "./assets/rat/closeups/closeup-20.webp",
  "./assets/rat/closeups/closeup-21.jpg",
  "./assets/rat/closeups/closeup-22.jpg",
];

// Closeup cycler timings.
const CLOSEUP_CYCLE_MS = 5500; // time between layer swaps
const CLOSEUP_KB_MS    = 7500; // duration of each ken-burns animation
const CLOSEUP_RECENT   = 8;    // last-N exclude window so a rat can't reappear soon

// --- GIF playback-rate plumbing (WebCodecs ImageDecoder) ---------------------
//
// Plain `<img>` elements play GIFs at their encoded frame rate with no DOM
// hook to change that. To re-roll playback speed alongside the color filter,
// each gif is decoded into ImageBitmap frames (cached per src so 2nd+ spawn
// is instant) and rendered to a <canvas> in a rAF loop that reads a per-spawn
// rate variable. Fallback: plain <img> if ImageDecoder is unavailable.

const HAS_IMAGE_DECODER = typeof ImageDecoder === "function";
const gifFramesCache = new Map(); // src -> Promise<{ frames: [{bitmap,durMs}], width, height }>

async function loadGifFrames(src) {
  if (gifFramesCache.has(src)) return gifFramesCache.get(src);
  const promise = (async () => {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to load ${src}: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const decoder = new ImageDecoder({ data: buf, type: "image/gif" });
    await decoder.tracks.ready;
    const total = decoder.tracks.selectedTrack.frameCount;
    const frames = [];
    let width = 0, height = 0;
    for (let i = 0; i < total; i++) {
      const r = await decoder.decode({ frameIndex: i });
      const bitmap = await createImageBitmap(r.image);
      // VideoFrame.duration is microseconds; many encoders default to ~100 ms.
      const durMs = r.image.duration ? r.image.duration / 1000 : 100;
      frames.push({ bitmap, durMs });
      width = bitmap.width;
      height = bitmap.height;
      r.image.close();
    }
    decoder.close();
    return { frames, width, height };
  })();
  gifFramesCache.set(src, promise);
  return promise;
}

const stage = document.getElementById("stage");
const audio = document.getElementById("audio");
const audioToggle = document.getElementById("audioToggle");
const centerRat = document.getElementById("centerRat");
const gate = document.getElementById("gate");
const gateRat = document.getElementById("gateRat");
const closeupA = document.getElementById("closeupA");
const closeupB = document.getElementById("closeupB");
const centerWrap = document.querySelector(".center-wrap");

// --- Audio toggle ------------------------------------------------------------

let muted = false;
function refreshAudioBtn() {
  audioToggle.textContent = muted ? "🔇 unmute" : "🔊 mute";
}
audioToggle.addEventListener("click", () => {
  muted = !muted;
  audio.muted = muted;
  if (!muted && audio.paused) audio.play().catch(() => {});
  refreshAudioBtn();
});
refreshAudioBtn();

// --- Flying gif orchestrator -------------------------------------------------

// Track which gifs are currently on-screen so we never spawn a duplicate.
const inFlightSrcs = new Set();

function pickFreshGif() {
  const available = POOL.filter((src) => !inFlightSrcs.has(src));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// Spawn a gif element flying across the viewport. Builds a <canvas> player
// when ImageDecoder is available so the playback speed can be re-rolled
// every FLY_EFFECT_MS; falls back to a plain <img> on older browsers.
async function spawnFlyingGif(src) {
  const useDecoder = HAS_IMAGE_DECODER;

  // Per-spawn FLIGHT speed (how fast the gif crosses the screen) and the
  // GIF playback rate. The playback rate re-rolls every FLY_EFFECT_MS but
  // is biased to the flight speed: faster flier → on average faster
  // playback, while 1× is always reachable.
  const flySpeed = rand(FLY_RATE_MIN, FLY_RATE_MAX);
  const rateRef = { v: rand(FLY_RATE_MIN, flySpeed) };

  let el;
  let stopPlayer = () => {};
  if (useDecoder) {
    const canvas = document.createElement("canvas");
    canvas.className = "rat-fly";
    el = canvas;
    try {
      const { frames, width, height } = await loadGifFrames(src);
      canvas.width = width;
      canvas.height = height;
      stopPlayer = startCanvasPlayer(canvas, frames, rateRef);
    } catch (err) {
      console.warn("GIF decode failed; falling back to <img>:", src, err);
      const img = document.createElement("img");
      img.className = "rat-fly";
      img.src = src;
      img.alt = "";
      img.decoding = "async";
      el = img;
    }
  } else {
    const img = document.createElement("img");
    img.className = "rat-fly";
    img.src = src;
    img.alt = "";
    img.decoding = "async";
    el = img;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Pick an entry edge and an exit edge so the gif clearly traverses the
  // screen at an angle. Bias toward horizontal motion (more readable).
  const edge = Math.random() < 0.7 ? "horizontal" : "vertical";
  const flip = Math.random() < 0.5;

  // Start point + delta in viewport coords. We size the delta so it's
  // guaranteed to leave the screen. Add a 240 px margin so the off-screen
  // start is fully out of view.
  const M = 240;
  let startX, startY, endX, endY;
  if (edge === "horizontal") {
    if (flip) {
      // right → left
      startX = vw + M;
      endX = -M - 200;
    } else {
      // left → right
      startX = -M - 200;
      endX = vw + M;
    }
    startY = rand(0, vh - 100);
    endY = startY + rand(-vh * 0.35, vh * 0.35);
  } else {
    if (flip) {
      // bottom → top
      startY = vh + M;
      endY = -M - 200;
    } else {
      // top → bottom
      startY = -M - 200;
      endY = vh + M;
    }
    startX = rand(0, vw - 100);
    endX = startX + rand(-vw * 0.35, vw * 0.35);
  }

  // Base fly duration is 7-14 s at 1×; faster fly speeds shorten it linearly.
  const baseDuration = rand(7000, 14000);
  const duration = baseDuration / flySpeed;
  const startRot = rand(-25, 25);
  const endRot = startRot + rand(-180, 180);

  el.style.transform = `translate3d(${startX}px, ${startY}px, 0) rotate(${startRot}deg)`;

  const anim = el.animate(
    [
      {
        transform: `translate3d(${startX}px, ${startY}px, 0) rotate(${startRot}deg)`,
      },
      {
        transform: `translate3d(${endX}px, ${endY}px, 0) rotate(${endRot}deg)`,
      },
    ],
    { duration, easing: "linear", fill: "forwards" },
  );

  inFlightSrcs.add(src);
  stage.appendChild(el);

  // Per-gif color + speed cycler — picks a random filter recipe AND a fresh
  // playback rate every FLY_EFFECT_MS so visual flair stays synchronized.
  el.style.transition = "filter 0.4s ease";
  applyRandomFlyEffect(el, rateRef, flySpeed);
  const flyEffectTimer = setInterval(
    () => applyRandomFlyEffect(el, rateRef, flySpeed),
    FLY_EFFECT_MS,
  );

  const cleanup = () => {
    clearInterval(flyEffectTimer);
    stopPlayer();
    inFlightSrcs.delete(src);
    el.remove();
  };

  anim.onfinish = () => {
    cleanup();
    // Replace with a different gif so the active count stays the same and
    // the rotation through the pool feels organic.
    const next = pickFreshGif();
    if (next) spawnFlyingGif(next);
  };
  anim.oncancel = cleanup;
}

function applyRandomFlyEffect(el, rateRef, flySpeed = FLY_RATE_MAX) {
  const idx = Math.floor(Math.random() * EFFECTS.length);
  // Combine with the baseline drop-shadow so flying gifs keep their depth
  // even when the chosen effect doesn't include one.
  el.style.filter = `${EFFECTS[idx]} drop-shadow(0 6px 14px rgba(0,0,0,0.6))`;
  // Re-roll playback rate biased to the flight speed: a 5× flier averages
  // toward 5× playback; a 1× flier locks at 1×; in all cases 1× is on the
  // table this tick.
  if (rateRef) rateRef.v = rand(FLY_RATE_MIN, Math.max(FLY_RATE_MIN, flySpeed));
}

// Run a per-canvas RAF loop that walks the decoded frame list, advancing
// `frameIdx` based on `dt * rateRef.v` so the gif plays at 1×–5× speed
// according to whatever the spawn's filter cycler has rolled. Returns a
// stop() function that cancels the loop.
function startCanvasPlayer(canvas, frames, rateRef) {
  const ctx = canvas.getContext("2d");
  let frameIdx = 0;
  let elapsedInFrame = 0;
  let lastT = 0;
  let raf = 0;
  let stopped = false;
  function tick(t) {
    if (stopped) return;
    if (lastT === 0) lastT = t;
    const dt = t - lastT;
    lastT = t;
    elapsedInFrame += dt * (rateRef.v || 1);
    let safety = frames.length; // never spin past one full cycle in a tick
    while (
      safety-- > 0 &&
      elapsedInFrame >= frames[frameIdx].durMs
    ) {
      elapsedInFrame -= frames[frameIdx].durMs;
      frameIdx = (frameIdx + 1) % frames.length;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frames[frameIdx].bitmap, 0, 0);
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

function bootSwarm() {
  // Stagger initial spawns so they don't all share the same trajectory phase.
  for (let i = 0; i < ACTIVE_COUNT; i++) {
    const src = pickFreshGif();
    if (!src) break;
    setTimeout(() => spawnFlyingGif(src), i * 600);
  }
}

// --- Center effect cycler ----------------------------------------------------

// CSS-filter recipes. Each is an applicable filter string the meme page can
// rotate through. Picked at random every 3 seconds for cheap, garish flair.
const EFFECTS = [
  "hue-rotate(45deg) saturate(1.4)",
  "hue-rotate(180deg) contrast(1.2)",
  "hue-rotate(270deg) saturate(1.6)",
  "invert(1) hue-rotate(180deg)",
  "saturate(2.5) brightness(1.1)",
  "contrast(1.6) brightness(1.05)",
  "blur(2px) saturate(1.4)",
  "sepia(0.85)",
  "grayscale(1) contrast(1.4)",
  "drop-shadow(0 0 18px #4169e1) saturate(1.4)",
  "drop-shadow(0 0 22px #2e8b57) brightness(1.15)",
  "drop-shadow(0 0 22px #9370db) hue-rotate(60deg)",
  "drop-shadow(0 0 26px #ff6347) saturate(2)",
  "contrast(0.7) brightness(1.3) saturate(1.4)",
  "blur(0.5px) hue-rotate(90deg) saturate(1.6)",
];

let lastEffectIdx = -1;
function cycleEffect() {
  let idx = Math.floor(Math.random() * EFFECTS.length);
  if (idx === lastEffectIdx && EFFECTS.length > 1) {
    idx = (idx + 1) % EFFECTS.length;
  }
  lastEffectIdx = idx;
  centerRat.style.filter = EFFECTS[idx];
}

// --- Closeup-background cycler ----------------------------------------------
//
// Two stacked layers (A / B) crossfade between rats so the screen is never
// black. Each layer's transform is randomized per cycle via the Web
// Animations API — every appearance is its own pan + zoom path. A
// recent-window dedupe keeps any rat from reappearing soon after it left.

const closeupLayers = [closeupA, closeupB];
let activeLayer = -1;
const recentSrcs = [];

function pickNextSrc() {
  if (CLOSEUPS.length === 0) return null;
  // Exclude the last N srcs unless that empties the pool.
  const candidates = CLOSEUPS.filter((s) => !recentSrcs.includes(s));
  const pool = candidates.length > 0 ? candidates : CLOSEUPS;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  recentSrcs.push(pick);
  while (recentSrcs.length > CLOSEUP_RECENT) recentSrcs.shift();
  return pick;
}

function randomKenBurnsKeyframes() {
  // Each cycle gets fresh start/end transforms so the pan + zoom feels
  // different every time (no repeating loop).
  const startScale = rand(1.05, 1.15);
  const endScale   = rand(startScale + 0.06, 1.32);
  const sx = rand(-3, 3);
  const sy = rand(-2.5, 2.5);
  // End offset chosen at a deliberate angle from start so the pan is
  // directional, not just a small wobble.
  const angle = Math.random() * Math.PI * 2;
  const reach = rand(2.5, 5);
  const ex = sx + Math.cos(angle) * reach;
  const ey = sy + Math.sin(angle) * reach;
  return [
    { transform: `scale(${startScale}) translate(${sx}%, ${sy}%)` },
    { transform: `scale(${endScale}) translate(${ex}%, ${ey}%)` },
  ];
}

let closeupAnims = [null, null]; // current animation handles per layer

function swapCloseup() {
  const next = activeLayer === -1 ? 0 : 1 - activeLayer;
  const layer = closeupLayers[next];
  const src = pickNextSrc();
  if (!src) return;
  layer.style.backgroundImage = `url("${src}")`;
  // Cancel any leftover animation on this layer before starting a new one.
  closeupAnims[next]?.cancel();
  closeupAnims[next] = layer.animate(randomKenBurnsKeyframes(), {
    duration: CLOSEUP_KB_MS,
    fill: "forwards",
    easing: "ease-out",
  });
  // Crossfade: incoming → 1, outgoing → 0. CSS transition (1.5 s) handles
  // the ramp so both layers are visible during the swap.
  layer.style.opacity = "1";
  if (activeLayer !== -1) closeupLayers[activeLayer].style.opacity = "0";
  activeLayer = next;
}

// --- Boot --------------------------------------------------------------------

// Everything stays inert until the user clicks the static rat on the gate.
// That click is the user gesture that unblocks audio autoplay, and it doubles
// as the "eat the rat" payoff.
function enter() {
  gate.hidden = true;
  document.body.classList.add("entered");
  audio.volume = 0.55;
  audio.play().catch(() => {
    // Pointerdown WAS the gesture — extremely rare for play() to still
    // reject. Surface via the toggle if it does.
    muted = true;
    audio.muted = true;
    refreshAudioBtn();
  });
  swapCloseup();
  setInterval(swapCloseup, CLOSEUP_CYCLE_MS);
  cycleEffect();
  setInterval(cycleEffect, CENTER_EFFECT_MS);
  // DVD-screensaver bounce on the center rat. Speed picked to feel lively
  // without crossing the screen too quickly.
  dvdBounce(centerWrap, { speed: 220 });
  bootSwarm();
}

gateRat.addEventListener("click", enter);
gateRat.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") enter();
});
