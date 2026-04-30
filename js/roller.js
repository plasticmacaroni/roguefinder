import { el, clearChildren } from "./util/dom.js";
import { store, subscribe, addToBuild, clearBuild, setPick } from "./state.js";
import { checkAndCascade } from "./picks-modal.js";
import { rollablePool } from "./selectors.js";
import { runBatchReels, openBloom } from "./spinner.js";
import { showToast } from "./toast.js";
import { buildShareUrl } from "./router.js";
import { openEmptyPoolModal } from "./empty-pool-modal.js";
import { celebrationDurationMs } from "./celebrate.js";
import {
  isMuted,
  setMuted,
  onMuteChange,
  isAudioSupported,
} from "./audio.js";

// The full roller widget: N stepper + Spin button + pool indicator + a
// stage where reels mount + a mute toggle. Wires multi-batch sequencing.

const MIN_N = 1;
const MAX_N = 12;
const BATCH_SIZE = 3;

let n = 3;
let spinning = false;
let _data = null;

export function renderRoller(parent, data) {
  _data = data;

  const stepper = el(
    "div",
    { class: "roller__stepper" },
    el("span", { class: "roller__stepper-label" }, "Roll"),
    el(
      "button",
      {
        class: "roller__stepper-btn",
        type: "button",
        "aria-label": "Decrease",
        onclick: () => setN(n - 1),
      },
      "−",
    ),
    el("span", { class: "roller__stepper-value", "data-roll-n": "1" }, "3"),
    el(
      "button",
      {
        class: "roller__stepper-btn",
        type: "button",
        "aria-label": "Increase",
        onclick: () => setN(n + 1),
      },
      "+",
    ),
    el("span", { class: "roller__stepper-suffix" }, "feats"),
  );

  const spinBtn = el(
    "button",
    {
      class: "spin-button",
      type: "button",
      onclick: () => onSpin(),
      "aria-label": "Spin the roller",
    },
    el("span", { class: "spin-button__label" }, "Spin"),
    el("span", { class: "spin-button__pool" }),
  );

  const muteBtn = el(
    "button",
    {
      class: "mute-toggle",
      type: "button",
      onclick: () => setMuted(!isMuted()),
      "aria-label": isMuted() ? "Unmute" : "Mute",
      title: isMuted() ? "Unmute audio" : "Mute audio",
    },
    isMuted() ? "🔇" : "🔊",
  );
  if (!isAudioSupported()) {
    muteBtn.disabled = true;
    muteBtn.title = "Audio not supported in this browser";
  }
  onMuteChange((m) => {
    muteBtn.textContent = m ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-label", m ? "Unmute" : "Mute");
    muteBtn.title = m ? "Unmute audio" : "Mute audio";
  });

  const shareBtn = el(
    "button",
    {
      class: "share-toggle",
      type: "button",
      title: "Copy a shareable link to your build",
      "aria-label": "Share build",
      onclick: () => onShare(),
    },
    "🔗",
  );
  // Disable when build is empty.
  const refreshShareBtn = () => {
    const empty = store.build.size === 0;
    shareBtn.disabled = empty;
    shareBtn.title = empty
      ? "Add feats to your build before sharing"
      : `Copy a shareable link (${store.build.size} feats)`;
  };
  subscribe("build", refreshShareBtn);
  refreshShareBtn();

  const clearBtn = el(
    "button",
    {
      class: "roller__clear",
      type: "button",
      title: "Clear all feats from your build",
      "aria-label": "Clear build",
      onclick: () => onClearBuild(),
    },
    "Clear build",
  );
  const refreshClearBtn = () => {
    clearBtn.disabled = store.build.size === 0;
  };
  subscribe("build", refreshClearBtn);
  refreshClearBtn();

  const controls = el(
    "div",
    { class: "roller__controls" },
    stepper,
    spinBtn,
    shareBtn,
    muteBtn,
    clearBtn,
  );

  const stage = el("div", {
    class: "spin-stage",
    "aria-live": "off",
    "aria-label": "Slot machine reels",
  });
  const status = el("div", {
    class: "sr-only",
    role: "status",
    "aria-live": "polite",
  });
  const batchProgress = el("div", {
    class: "batch-progress",
    role: "status",
    "aria-live": "polite",
  });

  const wrap = el(
    "section",
    { class: "roller", "aria-label": "Feat roller" },
    controls,
    batchProgress,
    stage,
    status,
  );

  parent.appendChild(wrap);

  function refresh() {
    if (spinning) return;
    const pool = rollablePool(store.filters, store.build, _data, store.autoBuild);
    const poolSize = pool.length;
    // Stay enabled when empty so the click can open the empty-pool popup.
    // Visually amber via .spin-button--empty.
    spinBtn.disabled = false;
    spinBtn.classList.toggle("spin-button--empty", poolSize === 0);
    spinBtn.querySelector(".spin-button__pool").textContent = poolSize > 0
      ? `from ${poolSize.toLocaleString()} feats`
      : "no feats match — tap to fix";
    spinBtn.querySelector(".spin-button__label").textContent =
      poolSize === 0 ? "No matches" : "Spin";
    spinBtn.setAttribute(
      "aria-label",
      poolSize > 0
        ? `Spin the roller — rolling from ${poolSize} eligible feats`
        : "No feats match — open the widen-filters dialog",
    );
    stepper.querySelector("[data-roll-n]").textContent = String(n);
    stepper.setAttribute("aria-label", `Roll ${n} feats per spin`);
  }

  subscribe("build", refresh);
  subscribe("filters", refresh);
  refresh();

  async function onSpin() {
    if (spinning) return;
    // Pool empty → open the help popup instead of running an empty spin.
    const initialPool = rollablePool(store.filters, store.build, _data, store.autoBuild);
    if (initialPool.length === 0) {
      openEmptyPoolModal({ filters: store.filters });
      return;
    }
    spinning = true;
    spinBtn.disabled = true;
    clearChildren(stage);

    const totalN = n;
    const batches = batchPlan(totalN);

    // Accumulate every landed feat across all batches; show ONE bloom at
    // the end so the user picks 1 from the full N (ROLL-17/18).
    const allLanded = [];
    const excludeIds = new Set();

    for (let bi = 0; bi < batches.length; bi++) {
      const batchSize = batches[bi];
      const basePool = rollablePool(store.filters, store.build, _data, store.autoBuild);
      const pool = basePool.filter((f) => !excludeIds.has(f.id));
      if (pool.length === 0) {
        showToast(
          `Pool exhausted — only ${allLanded.length} of ${totalN} reels rolled.`,
        );
        break;
      }
      batchProgress.textContent =
        batches.length > 1
          ? `Spin ${bi + 1} of ${batches.length}…`
          : "Spinning…";

      const landed = await runBatchReels(batchSize, pool, {
        stage,
        filters: store.filters,
      });
      for (const f of landed) {
        allLanded.push(f);
        excludeIds.add(f.id);
      }
    }

    batchProgress.textContent = "";

    if (allLanded.length === 0) {
      clearChildren(stage);
      showToast("No feats rolled — widen your filters.");
      spinning = false;
      refresh();
      return;
    }

    // Wait for the last reel's celebration (audio + animation) to play out
    // before the bloom covers the screen. Common = no wait.
    const lastRarity = allLanded[allLanded.length - 1]?.rarity;
    const wait = celebrationDurationMs(lastRarity);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    // ONE combined bloom for the whole spin.
    status.textContent = `Rolled ${allLanded.length} feat${allLanded.length > 1 ? "s" : ""} — pick one`;
    const result = await openBloom(allLanded);
    clearChildren(stage);

    if (result.picked) {
      addToBuild(result.picked.id);
      // Picker choices land in store.picks (not store.build). Walker reads
      // picks during DFS and pulls the chosen chain into autoBuild.
      // Choices persist across reloads and clear automatically when the
      // parent feat is removed. Unresolved pickers (user clicked the card
      // without choosing) surface as a non-dismissible cascade modal.
      if (result.chosenClassSlug) setPick(result.picked.id, "class", result.chosenClassSlug);
      if (result.chosenOrSlug) setPick(result.picked.id, "or", result.chosenOrSlug);
      showToast(`Added ${result.picked.name}`);
      // Surface any unmet pickers for the just-added feat. Async so the
      // bloom dialog finishes cleaning up first.
      setTimeout(() => checkAndCascade(_data), 0);
    } else if (result.skipped) {
      showToast("Spin skipped — your build is unchanged.");
    }

    spinning = false;
    refresh();
  }

  function setN(v) {
    n = Math.max(MIN_N, Math.min(MAX_N, v));
    stepper.querySelector("[data-roll-n]").textContent = String(n);
  }

  function onClearBuild() {
    if (store.build.size === 0) return;
    if (
      !window.confirm(
        `Clear all ${store.build.size} feats from your build? This can't be undone.`,
      )
    ) {
      return;
    }
    clearBuild();
    showToast("Build cleared");
  }

  async function onShare() {
    if (store.build.size === 0) return;
    const url = buildShareUrl(store.build, _data.indexOfId);
    try {
      await navigator.clipboard.writeText(url);
      showToast(`Copied share link · ${url.length} chars`);
    } catch (err) {
      // Clipboard API can fail (insecure context, permission, etc) — fall
      // back to selecting the URL in a prompt so the user can copy manually.
      console.warn("Clipboard write failed:", err);
      window.prompt("Copy this link to share your build:", url);
    }
  }
}

function batchPlan(total) {
  const batches = [];
  let remaining = total;
  while (remaining > 0) {
    const size = Math.min(BATCH_SIZE, remaining);
    batches.push(size);
    remaining -= size;
  }
  return batches;
}
