const Store = require('electron-store');

const DEFAULTS = {
  language: 'auto',        // 'auto' follows the OS, otherwise an explicit locale key
  thresholds: { warn: 60, crit: 85 },
  // Which meters the strip shows, by the keys usage.js derives from the API
  // (plus claude_status, which is local). Whatever the account actually has
  // decides what is offered; these two are what a fresh install opens with.
  visibleMeters: ['claude_status', 'session'],
  startAtLogin: false,
  // null = whichever monitor is primary. Only offered when more than one monitor
  // actually has a taskbar.
  monitorId: null,
  // Parks the strip in the taskbar's left corner instead of beside the clock —
  // dead space when the taskbar icons are centred.
  alignLeft: false,
  // Detailed Claude Code usage is kept locally. Both limits are enforced: age
  // handles normal rotation, while the size ceiling protects unusually busy
  // installations from growing without bound.
  consumptionRetention: { days: 30, maxMb: 100 },
  // Preços (USD por milhão de tokens) usados para ESTIMAR o custo na tela de
  // consumo — o transcript local só traz tokens, não valor. Entrada, saída e os
  // dois preços de prompt caching (escrita/leitura), aplicados a todos os
  // modelos; o padrão é o Opus e o usuário ajusta se trocar de modelo.
  pricing: {
    inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5,
  },
  // Fonte "VPS" da tela de consumo: a API do módulo PrestaShop que agrega o
  // consumo REAL da Sofia (action=ai_usage / ai_turns). Token READ-ONLY basta.
  vpsUrl: '',
  vpsToken: '',
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
    monitorId: store.get('monitorId', DEFAULTS.monitorId),
    alignLeft: store.get('alignLeft', DEFAULTS.alignLeft),
    consumptionRetention: normalizeRetention(store.get(
      'consumptionRetention', DEFAULTS.consumptionRetention)),
    pricing: normalizePricing(store.get('pricing', DEFAULTS.pricing)),
    vpsUrl: normalizeVpsUrl(store.get('vpsUrl', DEFAULTS.vpsUrl)),
    vpsToken: String(store.get('vpsToken', DEFAULTS.vpsToken) || '').trim(),
  };
}

/** URL http(s) sem barra final; qualquer outra coisa vira '' (não configurado). */
function normalizeVpsUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/.+/i.test(raw) ? raw : '';
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

/** Preços ≥ 0 (USD/MTok), com teto sensato; inválido cai no padrão. */
function normalizePricing(value) {
  const raw = value && typeof value === 'object' ? value : DEFAULTS.pricing;
  const clamp = (n, fallback) => {
    const num = Number(n);
    return Number.isFinite(num) && num >= 0 ? Math.min(num, 100000) : fallback;
  };
  return {
    inputPerMTok: clamp(raw.inputPerMTok, DEFAULTS.pricing.inputPerMTok),
    outputPerMTok: clamp(raw.outputPerMTok, DEFAULTS.pricing.outputPerMTok),
    cacheWritePerMTok: clamp(raw.cacheWritePerMTok, DEFAULTS.pricing.cacheWritePerMTok),
    cacheReadPerMTok: clamp(raw.cacheReadPerMTok, DEFAULTS.pricing.cacheReadPerMTok),
  };
}

function normalizeRetention(value) {
  const raw = value && typeof value === 'object' ? value : DEFAULTS.consumptionRetention;
  const days = Number.isFinite(Number(raw.days)) ? Math.round(Number(raw.days)) : DEFAULTS.consumptionRetention.days;
  const maxMb = Number.isFinite(Number(raw.maxMb)) ? Math.round(Number(raw.maxMb)) : DEFAULTS.consumptionRetention.maxMb;
  return {
    days: Math.min(Math.max(days, 7), 365),
    maxMb: Math.min(Math.max(maxMb, 25), 1000),
  };
}

function setSettings(patch) {
  if (patch.language !== undefined) store.set('language', patch.language);
  if (patch.thresholds) {
    store.set('thresholds', normalizeThresholds(patch.thresholds.warn, patch.thresholds.crit));
  }
  if (patch.visibleMeters !== undefined) store.set('visibleMeters', normalizeMeters(patch.visibleMeters));
  if (patch.startAtLogin !== undefined) store.set('startAtLogin', !!patch.startAtLogin);
  if (patch.monitorId !== undefined) {
    store.set('monitorId', Number.isFinite(patch.monitorId) ? patch.monitorId : null);
  }
  if (patch.alignLeft !== undefined) store.set('alignLeft', !!patch.alignLeft);
  if (patch.consumptionRetention !== undefined) {
    store.set('consumptionRetention', normalizeRetention(patch.consumptionRetention));
  }
  if (patch.pricing !== undefined) store.set('pricing', normalizePricing(patch.pricing));
  if (patch.vpsUrl !== undefined) store.set('vpsUrl', normalizeVpsUrl(patch.vpsUrl));
  if (patch.vpsToken !== undefined) store.set('vpsToken', String(patch.vpsToken || '').trim());
  return getSettings();
}

module.exports = {
  store, getSettings, setSettings, normalizeThresholds, normalizeMeters, normalizeRetention, normalizePricing, DEFAULTS,
};
