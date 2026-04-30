// dvd-bounce — tiny DVD-screensaver-style bouncer. ESM, dependency-free.
//
// Drives an element's transform along a velocity vector and reverses the
// matching axis on viewport-edge collision. The element should be
// `position: absolute | fixed` with `top: 0; left: 0`; this module owns the
// `translate3d(x, y, 0)` part of the transform. Compose other transforms
// (scale, rotate) in CSS animations on a CHILD element so they don't fight.
//
// Usage:
//   import { dvdBounce } from "./vendor/dvd-bounce.mjs";
//   const stop = dvdBounce(el, { speed: 220 });
//   // … later
//   stop();
//
// Options:
//   speed     — px/sec, default 220
//   angle     — initial angle in radians, default random
//   startX    — initial X position, default random in viewport
//   startY    — initial Y position, default random in viewport
//   onBounce  — callback fired on each edge hit, receives "x" or "y"

export function dvdBounce(el, opts = {}) {
  const speed = opts.speed ?? 220;
  const angle = opts.angle ?? Math.random() * Math.PI * 2;
  let vx = Math.cos(angle) * speed;
  let vy = Math.sin(angle) * speed;

  // Defer first read of offsetWidth/Height to the first tick so the element
  // has had a chance to lay out (matters when callers spawn the element in
  // the same microtask as starting the bounce).
  let x = opts.startX;
  let y = opts.startY;
  let initialized = x != null && y != null;

  let lastT = 0;
  let raf = 0;
  let stopped = false;

  function tick(t) {
    if (stopped) return;
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);

    if (!initialized) {
      x = Math.random() * maxX;
      y = Math.random() * maxY;
      initialized = true;
    }

    if (lastT === 0) lastT = t;
    const dt = Math.min((t - lastT) / 1000, 0.1); // clamp tab-resume jumps
    lastT = t;

    x += vx * dt;
    y += vy * dt;

    if (x <= 0) {
      x = 0;
      vx = Math.abs(vx);
      opts.onBounce?.("x");
    } else if (x >= maxX) {
      x = maxX;
      vx = -Math.abs(vx);
      opts.onBounce?.("x");
    }
    if (y <= 0) {
      y = 0;
      vy = Math.abs(vy);
      opts.onBounce?.("y");
    } else if (y >= maxY) {
      y = maxY;
      vy = -Math.abs(vy);
      opts.onBounce?.("y");
    }

    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}
