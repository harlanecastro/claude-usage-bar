/**
 * Translation + formatting.
 *
 * All user-facing strings are produced here in the main process and handed to
 * the renderers ready to paint. That keeps the widget renderer a dumb painter
 * and means the macOS tray (which renders offscreen) and the Windows taskbar
 * strip can never drift apart in wording.
 */
const { app } = require('electron');

const LOCALES = {
  en: require('../shared/locales/en.json'),
  'pt-BR': require('../shared/locales/pt-BR.json'),
  es: require('../shared/locales/es.json'),
};

const FALLBACK = 'en';

function availableLanguages() {
  return Object.keys(LOCALES).map((key) => ({ key, label: LOCALES[key].language }));
}

/** Map an OS locale like "pt-BR" / "pt" / "es-419" onto one we ship. */
function resolveLanguage(setting) {
  if (setting && setting !== 'auto' && LOCALES[setting]) return setting;

  const osLocale = (app.getLocale() || FALLBACK).toLowerCase();
  if (LOCALES[osLocale]) return osLocale;

  const exact = Object.keys(LOCALES).find((k) => k.toLowerCase() === osLocale);
  if (exact) return exact;

  const base = osLocale.split('-')[0];
  const byBase = Object.keys(LOCALES).find((k) => k.toLowerCase().split('-')[0] === base);
  return byBase || FALLBACK;
}

function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? String(vars[k]) : `{${k}}`));
}

class Translator {
  constructor(language) {
    this.language = language;
    this.dict = LOCALES[language] || LOCALES[FALLBACK];
  }

  t(path, vars) {
    const value = path.split('.').reduce((o, k) => (o == null ? o : o[k]), this.dict);
    if (typeof value !== 'string') return path;
    return interpolate(value, vars);
  }

  /**
   * "3 days 14 hours" / "3 dias e 14 horas" — the two largest non-zero units,
   * never abbreviated, joined with whatever the locale uses ("" vs " e ").
   */
  duration(ms) {
    if (ms <= 0) return this.t('duration.lessThanAMinute');

    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts = [];
    const push = (n, one, many) => {
      if (n > 0) parts.push(this.t(n === 1 ? one : many, { n }));
    };
    push(days, 'duration.day', 'duration.days');
    push(hours, 'duration.hour', 'duration.hours');
    if (days === 0) push(minutes, 'duration.minute', 'duration.minutes');

    if (parts.length === 0) return this.t('duration.lessThanAMinute');
    return parts.slice(0, 2).join(this.t('duration.join'));
  }

  date(timestamp) {
    return new Intl.DateTimeFormat(this.language, { day: 'numeric', month: 'long' })
      .format(new Date(timestamp));
  }
}

module.exports = { Translator, resolveLanguage, availableLanguages, LOCALES };
