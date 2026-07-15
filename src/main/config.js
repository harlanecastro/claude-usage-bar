const Store = require('electron-store');

const DEFAULTS = {
  language: 'auto',        // 'auto' follows the OS, otherwise an explicit locale key
  thresholds: { warn: 60, crit: 85 },
  showMonthly: false,
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
    showMonthly: store.get('showMonthly', DEFAULTS.showMonthly),
    startAtLogin: store.get('startAtLogin', DEFAULTS.startAtLogin),
  };
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
  if (patch.showMonthly !== undefined) store.set('showMonthly', !!patch.showMonthly);
  if (patch.startAtLogin !== undefined) store.set('startAtLogin', !!patch.startAtLogin);
  return getSettings();
}

module.exports = { store, getSettings, setSettings, normalizeThresholds, DEFAULTS };
