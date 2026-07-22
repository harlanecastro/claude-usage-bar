'use strict';

/* Gráfico de consumo — dispersão com duas fontes:
 *   Local: janelas de 5h do SQLite (tempo ativo × tokens de entrada+saída).
 *   VPS:   dias da Sofia via ai_usage (turnos no dia × tokens ponderados).
 * O desenho é o mesmo scatter; só os eixos/rotulagem mudam por fonte.
 */

const svg = document.querySelector('#chart');
const wrap = document.querySelector('#chartWrap');
const tooltip = document.querySelector('#tooltip');
const empty = document.querySelector('#empty');
const legendLocal = document.querySelector('#legendLocal');
const legendVps = document.querySelector('#legendVps');
const sourceTabs = document.querySelector('#sourceTabs');
const NS = 'http://www.w3.org/2000/svg';
const locale = new Intl.NumberFormat('pt-BR');
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });

let source = 'local'; // 'local' | 'vps'

function node(name, attributes = {}, text = null) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text != null) element.textContent = text;
  return element;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hours(minutes) {
  const value = minutes / 60;
  return Number.isInteger(value) ? `${value}h` : `${value.toFixed(1).replace('.', ',')}h`;
}

function showTooltip(event, text) {
  tooltip.textContent = text;
  tooltip.hidden = false;
  const bounds = wrap.getBoundingClientRect();
  const left = Math.min(event.clientX - bounds.left + 12, bounds.width - tooltip.offsetWidth - 8);
  const top = Math.max(8, event.clientY - bounds.top - tooltip.offsetHeight - 12);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${top}px`;
}

/* Sem dados/erro: só a mensagem centralizada — sem legenda nem área vazia. */
function showEmpty(text) {
  empty.textContent = text;
  empty.hidden = false;
  wrap.hidden = true;
  legendLocal.hidden = true;
  legendVps.hidden = true;
  svg.hidden = true;
  svg.replaceChildren();
}

function showChart() {
  empty.hidden = true;
  wrap.hidden = false;
  svg.hidden = false;
  legendLocal.hidden = source !== 'local';
  legendVps.hidden = source !== 'vps';
}

/**
 * Scatter genérico. Cada ponto: { x, y, label?, current?, tooltip, onClick? }.
 * axes: { xTick(value), yTick(value), xStep, yStep, xTitle, yTitle,
 *         quadrant, xMedianLabel, yMedianLabel }.
 */
function renderScatter(points, axes) {
  svg.replaceChildren();
  if (!points.length) {
    showEmpty(empty.textContent);
    return;
  }
  showChart();

  const width = 1100; const height = 650;
  const margin = { top: 34, right: 35, bottom: 75, left: 92 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xMax = Math.ceil(Math.max(...points.map((p) => p.x)) / axes.xStep) * axes.xStep || axes.xStep;
  const yMax = Math.ceil(Math.max(...points.map((p) => p.y)) / axes.yStep) * axes.yStep || axes.yStep;
  const x = (value) => margin.left + (value / xMax) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;
  const medianX = median(points.map((p) => p.x));
  const medianY = median(points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  svg.append(node('rect', { class: 'highlight', x: margin.left, y: margin.top, width: x(medianX) - margin.left, height: y(medianY) - margin.top }));
  for (let value = 0; value <= xMax; value += axes.xStep) {
    svg.append(node('line', { class: 'grid', x1: x(value), y1: margin.top, x2: x(value), y2: margin.top + plotHeight }));
    svg.append(node('text', { class: 'tick', x: x(value), y: margin.top + plotHeight + 27, 'text-anchor': 'middle', 'font-size': 14 }, axes.xTick(value)));
  }
  for (let value = 0; value <= yMax; value += axes.yStep) {
    svg.append(node('line', { class: 'grid', x1: margin.left, y1: y(value), x2: margin.left + plotWidth, y2: y(value) }));
    svg.append(node('text', { class: 'tick', x: margin.left - 16, y: y(value) + 5, 'text-anchor': 'end', 'font-size': 14 }, axes.yTick(value)));
  }
  svg.append(node('line', { class: 'median', x1: x(medianX), y1: margin.top, x2: x(medianX), y2: margin.top + plotHeight }));
  svg.append(node('line', { class: 'median', x1: margin.left, y1: y(medianY), x2: margin.left + plotWidth, y2: y(medianY) }));
  svg.append(node('text', { class: 'annotation', x: margin.left + 12, y: margin.top + 20, 'font-size': 14 }, axes.quadrant));
  svg.append(node('text', { class: 'annotation', x: x(medianX) + 8, y: margin.top + 20, 'font-size': 14 }, axes.xMedianLabel));
  svg.append(node('text', { class: 'annotation', x: margin.left + plotWidth - 8, y: y(medianY) - 9, 'text-anchor': 'end', 'font-size': 14 }, axes.yMedianLabel));
  svg.append(node('text', { class: 'axis-title', x: margin.left + plotWidth / 2, y: height - 18, 'text-anchor': 'middle', 'font-size': 16 }, axes.xTitle));
  svg.append(node('text', { class: 'axis-title', x: 18, y: margin.top + plotHeight / 2, 'text-anchor': 'middle', 'font-size': 16, transform: `rotate(-90 18 ${margin.top + plotHeight / 2})` }, axes.yTitle));

  for (const item of points) {
    const point = node('circle', { class: `point${item.current ? ' current' : ''}`, cx: x(item.x), cy: y(item.y), r: item.current ? 9 : 7, tabindex: 0, 'aria-label': item.tooltip });
    point.addEventListener('pointerenter', (event) => showTooltip(event, item.tooltip));
    point.addEventListener('pointermove', (event) => showTooltip(event, item.tooltip));
    point.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    if (item.onClick) {
      point.addEventListener('click', item.onClick);
      point.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.onClick(); }
      });
    }
    svg.append(point);
    if (item.current || item.y === maxY) {
      svg.append(node('text', { class: 'point-label', x: x(item.x) + 12, y: y(item.y) - 10, 'font-size': 14 }, item.current ? 'janela atual' : item.label));
    }
  }
}

function renderLocal(windows) {
  const data = windows.filter((item) => item.totalTokens > 0 && item.activeMinutes > 0);
  const points = data.map((item) => {
    const activeHours = Math.floor(item.activeMinutes / 60);
    const minutes = item.activeMinutes % 60;
    const rate = item.activeMinutes ? Math.round(item.totalTokens / item.activeMinutes) : 0;
    return {
      x: item.activeMinutes,
      y: item.totalTokens,
      label: day.format(new Date(item.startAt)),
      current: !!item.current,
      tooltip: `${day.format(new Date(item.startAt))} · ${activeHours}h ${String(minutes).padStart(2, '0')}min ativos · ${locale.format(item.totalTokens)} tokens · ${locale.format(rate)} tokens/min · ${locale.format(item.recordCount)} registros`,
      onClick: () => window.consumptionChartApi.openDetails({ startAt: item.startAt, endAt: item.endAt }),
    };
  });
  empty.textContent = 'Não há janelas de consumo para comparar.';
  renderScatter(points, {
    xStep: 120,
    yStep: 1000000,
    xTick: (value) => hours(value),
    yTick: (value) => (value ? `${value / 1000000} mi` : '0'),
    xTitle: 'Tempo com atividade (intervalos de 5 min)',
    yTitle: 'Tokens de entrada + saída',
    quadrant: 'menos tempo / mais tokens',
    xMedianLabel: 'mediana de tempo',
    yMedianLabel: 'mediana de tokens',
  });
}

function renderVps(series) {
  const data = series.filter((item) => item.turns > 0);
  const points = data.map((item) => {
    const weighted = item.input + 1.25 * item.cacheWrite + 0.1 * item.cacheRead + 5 * item.output;
    const cost = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(item.costUsd || 0);
    return {
      x: item.turns,
      y: weighted,
      label: day.format(new Date(`${item.day}T12:00:00`)),
      tooltip: `${day.format(new Date(`${item.day}T12:00:00`))} · ${locale.format(item.turns)} turnos · ${compact.format(weighted)} tokens ponderados · ${cost}`,
    };
  });
  const maxTurns = Math.max(1, ...points.map((p) => p.x));
  const xStep = Math.max(1, Math.ceil(maxTurns / 6));
  const maxWeighted = Math.max(1, ...points.map((p) => p.y));
  const magnitude = 10 ** Math.max(0, String(Math.ceil(maxWeighted / 6)).length - 1);
  const yStep = Math.ceil(maxWeighted / 6 / magnitude) * magnitude;
  empty.textContent = 'Sem dados de consumo da VPS neste período.';
  renderScatter(points, {
    xStep,
    yStep,
    xTick: (value) => locale.format(value),
    yTick: (value) => (value ? compact.format(value) : '0'),
    xTitle: 'Turnos no dia',
    yTitle: 'Tokens ponderados',
    quadrant: 'menos turnos / mais tokens',
    xMedianLabel: 'mediana de turnos',
    yMedianLabel: 'mediana de tokens',
  });
}

async function reload() {
  const wanted = source;
  try {
    if (wanted === 'local') {
      const result = await window.consumptionChartApi.overview();
      if (source !== wanted) return;
      renderLocal(Array.isArray(result?.windows) ? result.windows : []);
      return;
    }
    const result = await window.consumptionChartApi.vpsUsage(30);
    if (source !== wanted) return;
    if (result?.error === 'not_configured') {
      showEmpty('Configure a URL e o token da VPS nas Configurações para ver este gráfico.');
      return;
    }
    if (result?.error) {
      showEmpty(`Não foi possível carregar o consumo da VPS (${result.error}).`);
      return;
    }
    const rows = Array.isArray(result?.data?.usage) ? result.data.usage : [];
    renderVps(rows.map((row) => ({
      day: String(row.day),
      turns: Number(row.turns) || 0,
      input: Number(row.input_tokens) || 0,
      cacheWrite: Number(row.cache_write_tokens) || 0,
      cacheRead: Number(row.cache_read_tokens) || 0,
      output: Number(row.output_tokens) || 0,
      costUsd: Number(row.cost_usd) || 0,
    })));
  } catch {
    if (source !== wanted) return;
    showEmpty('Não foi possível carregar o gráfico de consumo.');
  }
}

function setSource(next) {
  if (next === source) return;
  source = next;
  for (const button of sourceTabs.querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.source === next);
  }
  tooltip.hidden = true;
  reload();
}

sourceTabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-source]');
  if (button) setSource(button.dataset.source);
});

let timer = null;
window.consumptionChartApi.onChanged(() => {
  if (source !== 'local') return; // o evento é do ingest local
  clearTimeout(timer);
  timer = setTimeout(reload, 500);
});
reload();
