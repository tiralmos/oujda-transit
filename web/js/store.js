// Small wrapper around localStorage. Every access is guarded: storage can be
// unavailable (private windows, blocked site data) and the app must still work.

const PREFIX = 'oujda-transit.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the setting just won't persist.
  }
}

export function createFavorites() {
  const state = load('favorites', { stops: [], lines: [] });
  if (!Array.isArray(state.stops)) state.stops = [];
  if (!Array.isArray(state.lines)) state.lines = [];
  return {
    has(kind, id) { return state[kind].includes(id); },
    toggle(kind, id) {
      const list = state[kind];
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1); else list.push(id);
      save('favorites', state);
      return i < 0;
    },
    list(kind) { return [...state[kind]]; },
  };
}

export function createRecents(max = 8) {
  let items = load('recents', []);
  if (!Array.isArray(items)) items = [];
  return {
    add(stopId) {
      items = [stopId, ...items.filter((id) => id !== stopId)].slice(0, max);
      save('recents', items);
    },
    list() { return [...items]; },
    clear() { items = []; save('recents', items); },
  };
}
