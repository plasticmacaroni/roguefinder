import confetti from "./vendor/confetti.mjs";
import { playKazoo, playWow } from "./audio.js";

// Per-reel celebration. Three tiers:
//   uncommon → quiet 'wow' + brighter glow on the reel center band
//   rare/unique → confetti burst (rarity-tinted) + louder kazoo
//
// Particles fall under gravity and clear naturally as they leave the
// viewport — the canvas is NOT force-cleared mid-fall.

const RARITY_COLORS = {
  rare: ["#4169e1", "#7da4ff", "#1f3aa6"],
  unique: ["#9370db", "#b89cef", "#5d3aa6"],
};

// How long each celebration's headline visuals + audio play for. Used by the
// roller to gate the bloom popup so it doesn't cover an in-flight effect.
// Common = 0 (no celebration). Numbers mirror the timeouts/animation lengths
// in this file so a tweak here stays in sync.
const CELEBRATION_DURATION_MS = {
  uncommon: 1200,
  rare:     1100,
  unique:   1100,
};

export function celebrationDurationMs(rarity) {
  return CELEBRATION_DURATION_MS[rarity] ?? 0;
}

export function celebrateReel(reelEl, rarity) {
  // Uncommon flourish: a green shockwave radiating from the reel center
  // OUTWARD past the reel's bounds (so it's clearly visible). Element is
  // body-attached so it's not clipped by the reel's overflow:hidden.
  if (rarity === "uncommon") {
    const r = reelEl.getBoundingClientRect();
    const pulse = document.createElement("div");
    pulse.className = "celebrate-pulse celebrate-pulse--uncommon";
    pulse.style.left = `${window.scrollX + r.left + r.width / 2}px`;
    pulse.style.top = `${window.scrollY + r.top + r.height / 2}px`;
    document.body.appendChild(pulse);
    pulse.addEventListener("animationend", () => pulse.remove(), { once: true });
    // Hard stop in case animationend never fires (reduced-motion etc.)
    setTimeout(() => pulse.remove(), 1500);

    reelEl.classList.add("reel--celebrate-uncommon");
    setTimeout(
      () => reelEl.classList.remove("reel--celebrate-uncommon"),
      1200,
    );
    playWow(0);
    return;
  }
  if (rarity !== "rare" && rarity !== "unique") return;

  // Compute origin from the reel's centerline (in normalized 0..1 viewport coords).
  const r = reelEl.getBoundingClientRect();
  const originX = (r.left + r.width / 2) / window.innerWidth;
  const originY = (r.top + r.height / 2) / window.innerHeight;

  const colors = RARITY_COLORS[rarity];

  // Two short bursts to feel like a small fanfare, ~1s total.
  confetti({
    particleCount: 60,
    spread: 70,
    startVelocity: 35,
    decay: 0.92,
    gravity: 1.0,
    ticks: 200, // particle lifespan in render frames
    origin: { x: originX, y: originY },
    colors,
    shapes: ["circle", "square"],
    scalar: 0.9,
    disableForReducedMotion: true,
  });
  setTimeout(() => {
    confetti({
      particleCount: 35,
      spread: 100,
      startVelocity: 28,
      decay: 0.93,
      gravity: 1.05,
      ticks: 220,
      origin: { x: originX, y: originY },
      colors,
      shapes: ["circle"],
      scalar: 0.8,
      disableForReducedMotion: true,
    });
  }, 180);

  // Kazoo: respects mute via audio.js
  playKazoo(0);
}
