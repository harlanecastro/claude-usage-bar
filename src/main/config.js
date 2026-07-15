const Store = require('electron-store');

const DEFAULTS = {
  language: 'auto',        // 'auto' follows the OS, otherwise an explicit locale key
  thresholds: { warn: 60, crit: 85 },
  // Which meters the strip shows, by the keys usage.js derives from the API.
  // Whatever the account actually has decides what is offered; these are just
  // the two everyone has.
  visibleMeters: ['session', 'weekly_all'],
  startAtLogin: false,
};

const store = new Store({ name: 'settings' });

function getSettings() {
  const t = store.get('thresholds', DEFAULTS.thresholds);
  return {
    language: store.get('language', DEFAULTS.language),
    // Clamped on read as well as write: a hand-edited settings.json should not
    // be able to produce an inverted or out-of-range colour scale.
    thresholds: normalizeThresholds(t.warn, t.crit),
    visibleMeters: normalizeMeters(store.get('visibleMeters', DEFAULTS.visibleMeters)),
    startAtLogin: store.get('startAtLogin', DEFAULTS.startAtLogin),
  };
}

/**
 * At least one meter must survive, or the strip would have nothing to say and
 * the user would be left staring at an empty taskbar with no way back.
 */
function normalizeMeters(list) {
  const clean = Array.isArray(list) ? [...new Set(list.filter((k) => typeof k === 'string' && k))] : [];
  return clean.length ? clean : [...DEFAULTS.visibleMeters];
}

function normalizeThresholds(warn, crit) {
  let w = Number.isFinite(warn) ? Math.round(warn) : DEFAULTS.thresholds.warn;
  let c = Number.isFinite(crit) ? Math.round(crit) : DEFAULTS.thresholds.crit;
  w = Math.min(Math.max(w, 5), 90);
  c = Math.min(Math.max(c, w + 5), 95);
  return { warn: w, crit: c };
}

function setSettings(patch) {
  if (patch.language !== undefined) store.set('language', patch.language);
  if (patch.thresholds) {
    store.set('thresholds', normalizeThresholds(patch.thresholds.warn, patch.thresholds.crit));
  }
  if (patch.visibleMeters !== undefined) store.set('visibleMeters', normalizeMeters(patch.visibleMeters));
  if (patch.startAtLogin !== undefined) store.set('startAtLogin', !!patch.startAtLogin);
  return getSettings();
}

module.exports = { store, getSettings, setSettings, normalizeThresholds, normalizeMeters, DEFAULTS };
