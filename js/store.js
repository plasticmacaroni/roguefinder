// Proxy-backed reactive store with per-key + wildcard subscription.
// MUTATION DISCIPLINE: replace whole values, never mutate in place.
//   ✓  store.build = new Set([...store.build, id]);
//   ✗  store.build.add(id);            // does NOT fire the proxy trap
//   ✗  store.filters.types.push("X");  // same — won't notify

export function createStore(initial) {
  const subs = new Map(); // key -> Set<fn>; "*" -> Set<fn> for wildcard

  const target = { ...initial };

  function notify(key, value) {
    const exact = subs.get(key);
    if (exact) for (const fn of exact) fn(value, key);
    const wild = subs.get("*");
    if (wild) for (const fn of wild) fn(value, key);
  }

  const proxy = new Proxy(target, {
    set(obj, key, value) {
      if (obj[key] === value) return true;
      obj[key] = value;
      notify(key, value);
      return true;
    },
  });

  function subscribe(key, fn) {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    return () => subs.get(key).delete(fn);
  }

  function subscribeAll(fn) {
    return subscribe("*", fn);
  }

  return { store: proxy, subscribe, subscribeAll };
}
