import { el, clearChildren } from "./util/dom.js";
import { createReel } from "./reel.js";
import { playTick, unlockAudio, startChoiceMusic, stopChoiceMusic } from "./audio.js";
import { celebrateReel } from "./celebrate.js";
import { renderFeatTitle, renderFeatBody } from "./detail.js";
import { sampleWeightedDistinct, hasActiveWeights } from "./selectors.js";

// Run a single spin batch: spawn N reels, scroll them ONE AT A TIME (each
// reel completes its full spin before the next starts), then bloom popup
// with the N landed feats. Resolves to either { picked: feat } or
// { skipped: true } or { empty: true }.
//
// `pool` must already exclude in-build feats and chain-locked feats. The
// caller is also responsible for not spinning when the pool is < 1.

// Spin reels for one batch and return the landed feats (no popup). The
// caller is responsible for collecting results across batches and opening
// a single combined bloom at the end (ROLL-17/18).
export async function runBatchReels(reelCount, pool, opts = {}) {
  const stage = opts.stage;
  if (!stage) throw new Error("runBatchReels: stage element required");
  await unlockAudio();
  clearChildren(stage);

  const desiredCount = Math.max(1, Math.min(reelCount, 3));
  const realCount = Math.min(desiredCount, pool.length);
  if (realCount === 0) return [];

  const targets =
    opts.filters && hasActiveWeights(opts.filters)
      ? sampleWeightedDistinct(pool, realCount, opts.filters)
      : sampleDistinct(pool, realCount);

  // Layout choice: side-by-side vs stacked, based on the stage's available width.
  const stageRect = stage.getBoundingClientRect();
  const minReelWidth = 240;
  const stack = stageRect.width < minReelWidth * realCount;
  stage.classList.toggle("spin-stage--stack", stack);
  stage.classList.toggle("spin-stage--row", !stack);

  // Pre-create all reels so they take their layout slots up-front (no jumps
  // mid-spin). Each reel sits dimmed/idle until it's its turn to spin.
  const reels = targets.map((target) => {
    const reel = createReel(stage, pool, target, {
      duration: 1500,
      onTickPass: () => playTick(0),
    });
    reel.el.classList.add("reel--idle");
    return reel;
  });

  // Click-anywhere fast-forwards the CURRENTLY spinning reel only (so users
  // can hurry through a batch without wiping the rest).
  let activeReel = null;
  const ffHandler = (e) => {
    if (e.target.closest(".bloom-dialog")) return;
    if (activeReel) activeReel.fastForward();
  };
  stage.addEventListener("click", ffHandler);

  // Spin reels one after the other.
  const landed = [];
  for (const r of reels) {
    r.el.classList.remove("reel--idle");
    r.el.classList.add("reel--active");
    activeReel = r;
    const result = await r.spin();
    activeReel = null;
    r.el.classList.remove("reel--active");
    // celebrateReel handles per-rarity branching (uncommon → wow + shockwave;
    // rare/unique → confetti + kazoo; common → no-op). Invoke unconditionally.
    celebrateReel(r.el, result.rarity);
    landed.push(result);
  }

  stage.removeEventListener("click", ffHandler);
  return landed;
}

// Backwards-compat single-batch entry point: spin and immediately open a
// bloom for that batch. Kept for callers that still want the per-batch flow,
// but the multi-batch roller no longer uses this path.
export async function runBatch(reelCount, pool, opts = {}) {
  const landed = await runBatchReels(reelCount, pool, opts);
  if (landed.length === 0) return { empty: true };
  return openBloom(landed);
}

// Exported so the multi-batch roller can open a combined bloom containing
// every landed feat across all batches.
export { openBloom };

function sampleDistinct(pool, count) {
  // Shuffle pool indices, take first `count`. Pool size >= count guaranteed
  // by caller.
  const idxs = Array.from({ length: pool.length }, (_, i) => i);
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }
  return idxs.slice(0, count).map((i) => pool[i]);
}

// Open a bloom popup containing 1..N feat cards. User picks one, skips
// the batch, or hits Esc. Resolves to { picked } or { skipped }.
function openBloom(landedFeats) {
  if (!landedFeats || landedFeats.length === 0) {
    return Promise.resolve({ skipped: true });
  }
  startChoiceMusic();
  return new Promise((resolve) => {
    const dialog = el("dialog", {
      class: "bloom-dialog",
      "aria-label": "Pick one of your rolled feats",
    });

    const cards = landedFeats.map((feat, i) => {
      const card = buildBloomCard(feat, i, () => {
        // Bloom click ALWAYS commits. Picker choices are convenience —
        // unresolved picks cascade as a non-dismissible modal post-pick.
        const chosenOrSlug = card.querySelector("[data-or-chosen]")?.value || "";
        const chosenClassSlug = card.querySelector("[data-class-chosen]")?.value || "";
        cleanup();
        resolve({ picked: feat, chosenOrSlug, chosenClassSlug });
      });
      return card;
    });

    const skipBtn = el(
      "button",
      {
        class: "bloom-skip",
        type: "button",
        onclick: () => {
          cleanup();
          resolve({ skipped: true });
        },
      },
      "Skip this batch",
    );

    // Scrollable content area — native overflow:auto handles touch/wheel
    // scrolling. Drag-grip rail removed per user request.
    const scrollArea = el(
      "div",
      { class: "bloom-dialog__scroll" },
      el(
        "div",
        { class: "bloom-head" },
        el("h2", { class: "bloom-title" }, "Pick one"),
        el(
          "p",
          { class: "bloom-sub" },
          `${cards.length} feat${cards.length > 1 ? "s" : ""} rolled. Tap a card to add it, or skip this batch.`,
        ),
      ),
      el("div", { class: "bloom-card-row" }, cards),
      el("div", { class: "bloom-foot" }, skipBtn),
    );

    dialog.append(scrollArea);

    document.body.appendChild(dialog);
    dialog.showModal();

    // Keyboard: 1/2/3 = pick that index; Esc = skip
    function onKey(e) {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= cards.length) {
        e.preventDefault();
        cards[n - 1].click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        skipBtn.click();
      }
    }
    document.addEventListener("keydown", onKey);

    // No backdrop dismiss — user MUST pick or skip explicitly.
    // Native <dialog> would close on backdrop click; we suppress it.
    dialog.addEventListener("cancel", (e) => e.preventDefault());

    function cleanup() {
      document.removeEventListener("keydown", onKey);
      if (dialog.open) dialog.close();
      dialog.remove();
      stopChoiceMusic();
    }
  });
}

// A tall left-side rail that drag-scrolls the popup's scroll area. Visual
// affordance for touch users on narrow screens; mouse users can also drag.
// Native touch-scrolling on the content still works as a fallback.
function buildPopupGrip(scrollArea) {
  const dotCol = el(
    "div",
    { class: "bloom-dialog__grip-dots", "aria-hidden": "true" },
    Array.from({ length: 14 }, () =>
      el("span", { class: "bloom-dialog__grip-dot" }),
    ),
  );

  const grip = el(
    "div",
    {
      class: "bloom-dialog__grip",
      role: "scrollbar",
      "aria-orientation": "vertical",
      "aria-label": "Scroll feat results",
      tabindex: "0",
    },
    el("span", { class: "bloom-dialog__grip-label" }, "scroll"),
    dotCol,
    el("span", { class: "bloom-dialog__grip-label" }, "scroll"),
  );

  // Drag-to-scroll: 1:1 pixel mapping (drag down N px → scrollTop += N).
  // Use Pointer Events so mouse + touch + pen all work.
  let startY = 0;
  let startScroll = 0;
  let dragging = false;

  grip.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    startScroll = scrollArea.scrollTop;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("bloom-dialog__grip--active");
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const delta = e.clientY - startY;
    scrollArea.scrollTop = startScroll + delta;
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove("bloom-dialog__grip--active");
    if (grip.hasPointerCapture(e.pointerId)) {
      grip.releasePointerCapture(e.pointerId);
    }
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  // Keyboard arrows on the grip = scroll the area.
  grip.addEventListener("keydown", (e) => {
    const step = 80;
    if (e.key === "ArrowDown" || e.key === "PageDown") {
      scrollArea.scrollTop += step;
      e.preventDefault();
    } else if (e.key === "ArrowUp" || e.key === "PageUp") {
      scrollArea.scrollTop -= step;
      e.preventDefault();
    } else if (e.key === "Home") {
      scrollArea.scrollTop = 0;
      e.preventDefault();
    } else if (e.key === "End") {
      scrollArea.scrollTop = scrollArea.scrollHeight;
      e.preventDefault();
    }
  });

  return grip;
}

// One bloom card. Reuses renderFeatTitle / renderFeatBody from detail.js so
// it visually matches the manual feat-detail modal — single source of truth.
// The card is fully expanded (no internal scroll); the popup itself scrolls.
function buildBloomCard(feat, idx, onPick) {
  const numBadge = el(
    "span",
    { class: "bloom-card__num", "aria-hidden": "true" },
    String(idx + 1),
  );
  const title = renderFeatTitle(feat);

  // Tuck the number badge inside the title row so it sits beside the name
  // without needing a separate flex container.
  title.prepend(numBadge);

  const body = renderFeatBody(feat, { interactive: false });

  return el(
    "button",
    {
      class: "bloom-card",
      dataset: { rarity: feat.rarity, featId: feat.id },
      type: "button",
      onclick: onPick,
      "aria-label": `Pick ${feat.name}`,
    },
    title,
    ...body,
  );
}
