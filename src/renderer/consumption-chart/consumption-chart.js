'use strict';

const svg = document.querySelector('#chart');
const wrap = document.querySelector('#chartWrap');
const tooltip = document.querySelector('#tooltip');
const empty = document.querySelector('#empty');
const NS = 'http://www.w3.org/2000/svg';
const locale = new Intl.NumberFormat('pt-BR');
const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });

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

function description(item) {
  const activeHours = Math.floor(item.activeMinutes / 60);
  const minutes = item.activeMinutes % 60;
  const duration = `${activeHours}h ${String(minutes).padStart(2, '0')}min ativos`;
  const rate = item.activeMinutes ? Math.round(item.totalTokens / item.activeMinutes) : 0;
  return `${day.format(new Date(item.startAt))} · ${duration} · ${locale.format(item.totalTokens)} tokens · ${locale.format(rate)} tokens/min · ${locale.format(item.recordCount)} registros`;
}

function showTooltip(event, item) {
  tooltip.textContent = description(item);
  tooltip.hidden = false;
  const bounds = wrap.getBoundingClientRect();
  const left = Math.min(event.clientX - bounds.left + 12, bounds.width - tooltip.offsetWidth - 8);
  const top = Math.max(8, event.clientY - bounds.top - tooltip.offsetHeight - 12);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${top}px`;
}

function render(windows) {
  svg.replaceChildren();
  const data = windows.filter((item) => item.totalTokens > 0 && item.activeMinutes > 0);
  empty.hidden = data.length > 0;
  svg.hidden = data.length === 0;
  if (!data.length) return;

  const width = 1100; const height = 650;
  const margin = { top: 34, right: 35, bottom: 75, left: 92 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxMinutes = Math.max(...data.map((item) => item.activeMinutes));
  const maxTokens = Math.max(...data.map((item) => item.totalTokens));
  const xMax = Math.ceil(maxMinutes / 120) * 120 || 120;
  const yMax = Math.ceil(maxTokens / 1000000) * 1000000 || 1000000;
  const x = (value) => margin.left + (value / xMax) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;
  const medianMinutes = median(data.map((item) => item.activeMinutes));
  const medianTokens = median(data.map((item) => item.totalTokens));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  svg.append(node('rect', { class: 'highlight', x: margin.left, y: margin.top, width: x(medianMinutes) - margin.left, height: y(medianTokens) - margin.top }));
  for (let value = 0; value <= xMax; value += 120) {
    svg.append(node('line', { class: 'grid', x1: x(value), y1: margin.top, x2: x(value), y2: margin.top + plotHeight }));
    svg.append(node('text', { class: 'tick', x: x(value), y: margin.top + plotHeight + 27, 'text-anchor': 'middle', 'font-size': 14 }, hours(value)));
  }
  for (let value = 0; value <= yMax; value += 1000000) {
    svg.append(node('line', { class: 'grid', x1: margin.left, y1: y(value), x2: margin.left + plotWidth, y2: y(value) }));
    svg.append(node('text', { class: 'tick', x: margin.left - 16, y: y(value) + 5, 'text-anchor': 'end', 'font-size': 14 }, value ? `${value / 1000000} mi` : '0'));
  }
  svg.append(node('line', { class: 'median', x1: x(medianMinutes), y1: margin.top, x2: x(medianMinutes), y2: margin.top + plotHeight }));
  svg.append(node('line', { class: 'median', x1: margin.left, y1: y(medianTokens), x2: margin.left + plotWidth, y2: y(medianTokens) }));
  svg.append(node('text', { class: 'annotation', x: margin.left + 12, y: margin.top + 20, 'font-size': 14 }, 'menos tempo / mais tokens'));
  svg.append(node('text', { class: 'annotation', x: x(medianMinutes) + 8, y: margin.top + 20, 'font-size': 14 }, 'mediana de tempo'));
  svg.append(node('text', { class: 'annotation', x: margin.left + plotWidth - 8, y: y(medianTokens) - 9, 'text-anchor': 'end', 'font-size': 14 }, 'mediana de tokens'));
  svg.append(node('text', { class: 'axis-title', x: margin.left + plotWidth / 2, y: height - 18, 'text-anchor': 'middle', 'font-size': 16 }, 'Tempo com atividade (intervalos de 5 min)'));
  const yTitle = node('text', { class: 'axis-title', x: 18, y: margin.top + plotHeight / 2, 'text-anchor': 'middle', 'font-size': 16, transform: `rotate(-90 18 ${margin.top + plotHeight / 2})` }, 'Tokens de entrada + saída');
  svg.append(yTitle);

  for (const item of data) {
    const point = node('circle', { class: `point${item.current ? ' current' : ''}`, cx: x(item.activeMinutes), cy: y(item.totalTokens), r: item.current ? 9 : 7, tabindex: 0, 'aria-label': description(item) });
    point.addEventListener('pointerenter', (event) => showTooltip(event, item));
    point.addEventListener('pointermove', (event) => showTooltip(event, item));
    point.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    point.addEventListener('click', () => window.consumptionChartApi.openDetails({ startAt: item.startAt, endAt: item.endAt }));
    point.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); point.dispatchEvent(new MouseEvent('click')); }
    });
    svg.append(point);
    if (item.current || item.totalTokens === maxTokens) {
      svg.append(node('text', { class: 'point-label', x: x(item.activeMinutes) + 12, y: y(item.totalTokens) - 10, 'font-size': 14 }, item.current ? 'janela atual' : day.format(new Date(item.startAt))));
    }
  }
}

async function reload() {
  try {
    const result = await window.consumptionChartApi.overview();
    render(Array.isArray(result?.windows) ? result.windows : []);
  } catch {
    empty.textContent = 'Não foi possível carregar o gráfico de consumo.';
    empty.hidden = false;
    svg.hidden = true;
  }
}

let timer = null;
window.consumptionChartApi.onChanged(() => {
  clearTimeout(timer);
  timer = setTimeout(reload, 500);
});
reload();
