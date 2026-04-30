import { el, clearChildren } from "./util/dom.js";

// A single slot-machine reel. Vertical strip, a window of N cells visible,
// the center cell is the "stop position". Cubic-out deceleration.
//
//   const reel = createReel(container, pool, targetFeat, {
//     visibleRows: 5,
//     duration: 1500,         // ms
//     onTickPass: (cellIdx) => audio.playTick(),
//   });
//   await reel.spin();        // resolves when the reel stops on targetFeat
//
// `pool` is a non-empty array of feat objects. `targetFeat` MUST be one of
// them (caller picks before spawn so duplicates across reels can be avoided).

const CELL_HEIGHT = 56; // px; matches CSS .reel__cell { height: 56px }
const STRIP_LENGTH_FACTOR = 25; // ~25 cells worth of scroll before the target
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createReel(container, pool, targetFeat, opts = {}) {
  const visibleRows = opts.visibleRows ?? 5;
  const duration = REDUCED_MOTION ? 1 : (opts.duration ?? 1500);
  const onTickPass = opts.onTickPass ?? (() => {});
  const onStop = opts.onStop ?? (() => {});

  const reelEl = el("div", { class: "reel" });
  reelEl.style.height = `${CELL_HEIGHT * visibleRows}px`;

  const stripEl = el("div", { class: "reel__strip" });
  reelEl.append(stripEl, el("div", { class: "reel__center", "aria-hidden": "true" }));

  // Center cell index in the visible window
  const centerOffsetCells = Math.floor(visibleRows / 2);

  // Strip composition: many random cells from pool, with `targetFeat` at a
  // specific final index so the spin lands precisely.
  const stripCount = STRIP_LENGTH_FACTOR + visibleRows;
  const targetIdx = stripCount - 1 - centerOffsetCells; // when this cell is at center, targetFeat shows
  const cells = [];
  for (let i = 0; i < stripCount; i++) {
    const feat = i === targetIdx ? targetFeat : pickRandom(pool);
    cells.push(feat);
    stripEl.appendChild(renderCell(feat));
  }

  container.appendChild(reelEl);

  // Initial position: top of strip, so the first cells are visible.
  let currentY = 0;
  // Final position: shift the strip up so targetIdx sits at center.
  const finalY = -((targetIdx - centerOffsetCells) * CELL_HEIGHT);
  const totalDistance = finalY - currentY; // negative

  let startTime = 0;
  let lastCenterIdx = centerOffsetCells; // first cell at the center initially
  let raf = 0;
  let resolveSpin = null;

  function frame(now) {
    if (!startTime) startTime = now;
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // cubic-out
    currentY = totalDistance * eased;
    stripEl.style.transform = `translate3d(0, ${currentY}px, 0)`;

    // Compute which cell is currently at center. Center of viewport in strip
    // coords = -currentY + centerOffsetCells * CELL_HEIGHT + CELL_HEIGHT/2
    const centerStripY =
      -currentY + centerOffsetCells * CELL_HEIGHT + CELL_HEIGHT / 2;
    const centerIdx = Math.floor(centerStripY / CELL_HEIGHT);
    if (centerIdx !== lastCenterIdx) {
      const stepsCrossed = centerIdx - lastCenterIdx;
      // Fire onTickPass for each cell crossed (handles fast frames).
      for (let i = 1; i <= Math.min(stepsCrossed, 4); i++) {
        onTickPass(lastCenterIdx + i);
      }
      lastCenterIdx = centerIdx;
    }

    if (t < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      // Snap to exact final position (avoid sub-pixel drift).
      stripEl.style.transform = `translate3d(0, ${finalY}px, 0)`;
      raf = 0;
      reelEl.classList.add("reel--locked");
      reelEl.dataset.rarity = targetFeat.rarity;
      onStop(targetFeat);
      resolveSpin?.(targetFeat);
    }
  }

  return {
    el: reelEl,
    targetFeat,
    spin() {
      return new Promise((resolve) => {
        resolveSpin = resolve;
        if (REDUCED_MOTION) {
          // Snap immediately; one tick.
          stripEl.style.transform = `translate3d(0, ${finalY}px, 0)`;
          onTickPass(targetIdx);
          reelEl.classList.add("reel--locked");
          reelEl.dataset.rarity = targetFeat.rarity;
          onStop(targetFeat);
          resolve(targetFeat);
          return;
        }
        startTime = 0;
        raf = requestAnimationFrame(frame);
      });
    },
    fastForward() {
      if (raf) cancelAnimationFrame(raf);
      stripEl.style.transform = `translate3d(0, ${finalY}px, 0)`;
      reelEl.classList.add("reel--locked");
      reelEl.dataset.rarity = targetFeat.rarity;
      onStop(targetFeat);
      resolveSpin?.(targetFeat);
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      reelEl.remove();
    },
  };
}

function renderCell(feat) {
  return el(
    "div",
    {
      class: "reel__cell",
      dataset: { rarity: feat.rarity, featId: feat.id },
    },
    el("span", { class: "reel__cell-name" }, feat.name),
    el("span", { class: "reel__cell-level" }, `L${feat.level}`),
  );
}

function pickRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}
