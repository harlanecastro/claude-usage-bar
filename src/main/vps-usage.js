'use strict';

/**
 * Fonte "VPS" da tela de consumo: consulta a API do módulo PrestaShop
 * (atendimentoapi) que agrega o consumo REAL da Sofia por dia (ai_usage) e por
 * turno (ai_turns). Roda no MAIN process — a CSP das telas (default-src
 * 'none') não permite fetch no renderer. Espelha o formato de URL do app de
 * atendimento: {vpsUrl}?fc=module&module=cxmessagingnotifications&controller=
 * atendimentoapi&action=... com header X-App-Token (token read-only basta).
 *
 * Erros voltam como { error: 'not_configured' | 'network' | 'http_<status>'
 * | 'bad_json' } — a UI traduz em estados amigáveis, nunca em crash.
 */
const { getSettings } = require('./config');

const TIMEOUT_MS = 15_000;

function buildUrl(base, action, params = {}) {
  const url = new URL(base.includes('?') ? base : `${base}/index.php`);
  url.searchParams.set('fc', 'module');
  url.searchParams.set('module', 'cxmessagingnotifications');
  url.searchParams.set('controller', 'atendimentoapi');
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function request(action, params) {
  const { vpsUrl, vpsToken } = getSettings();
  if (!vpsUrl || !vpsToken) return { error: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(buildUrl(vpsUrl, action, params), {
      headers: { 'X-App-Token': vpsToken },
      signal: controller.signal,
    });
    if (!response.ok) return { error: `http_${response.status}` };
    try {
      return { data: await response.json() };
    } catch {
      return { error: 'bad_json' };
    }
  } catch {
    return { error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function fetchAiUsage(days = 30) {
  return request('ai_usage', { days: Math.min(Math.max(Number(days) || 30, 1), 90) });
}

function fetchAiTurns(day) {
  const safeDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : '';
  if (!safeDay) return Promise.resolve({ error: 'bad_day' });
  return request('ai_turns', { day: safeDay });
}

module.exports = { fetchAiUsage, fetchAiTurns };
