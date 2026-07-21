'use strict';

/* Dashboard de consumo — visão agregada por dia com o raio-X do cache.
 * Renderiza a MESMA série normalizada para qualquer fonte:
 *   { day:'YYYY-MM-DD', turns, input, cacheWrite, cacheRead, output,
 *     costUsd, hypotheticalUsd, estimated }
 * Compartilha t()/number()/create()/state com consumption.js (carregado antes).
 * Fórmulas exibidas (mesma régua da análise de custo da Sofia):
 *   ponderado = input + 1,25×write + 0,1×read + 5×output
 *   cache aproveitado = read / (read + write + input)
 *   economia = hypotheticalUsd − costUsd (tokens: read × 0,9)
 */

const DASH_SVG_NS = 'http://www.w3.org/2000/svg';

function weightedOf(day) {
  return day.input + 1.25 * day.cacheWrite + 0.1 * day.cacheRead + 5 * day.output;
}

function cacheShareOf(day) {
  const base = day.cacheRead + day.cacheWrite + day.input;
  return base > 0 ? day.cacheRead / base : 0;
}

function savingsUsdOf(day) {
  return Math.max(0, (day.hypotheticalUsd || 0) - (day.costUsd || 0));
}

function usd(value) {
  return new Intl.NumberFormat(state.locale, {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function compactTokens(value) {
  return new Intl.NumberFormat(state.locale, {
    notation: 'compact', maximumFractionDigits: 1,
  }).format(Number(value) || 0);
}

function shortDay(iso) {
  const [, month, day] = String(iso).split('-');
  return `${day}/${month}`;
}

function svgNode(tag, attributes) {
  const node = document.createElementNS(DASH_SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function dashTile(label, value, hint, kind) {
  const tile = create('div', `dash-tile${kind ? ` ${kind}` : ''}`);
  tile.append(
    create('span', 'dash-tile-label', label),
    create('strong', 'dash-tile-value', value),
    create('small', 'dash-tile-hint', hint || ''),
  );
  return tile;
}

function renderDashTiles(host, series) {
  const latest = series[series.length - 1];
  const wrap = create('div', 'dash-tiles');
  if (!latest) {
    host.append(wrap);
    return;
  }
  const share = cacheShareOf(latest);
  const savings = savingsUsdOf(latest);
  const savedTokens = Math.round(latest.cacheRead * 0.9);
  const estimated = latest.estimated ? ` · ${t('dashEstimated')}` : '';
  wrap.append(
    dashTile(t('dashTurns'), number(latest.turns), shortDay(latest.day)),
    dashTile(t('dashWeighted'), compactTokens(weightedOf(latest)), t('tokens')),
    dashTile(t('dashCost'), usd(latest.costUsd), `${t('dashCostDay')}${estimated}`, 'cost'),
    dashTile(t('dashSavings'), latest.estimated ? compactTokens(savedTokens) : usd(savings),
      latest.estimated ? `${t('tokens')} · ${usd(savings)}` : t('dashSavingsHint'), 'eco'),
    dashTile(t('dashCacheShare'), `${Math.round(share * 100)}%`, t('dashCacheShareHint'), 'eco'),
  );
  host.append(wrap);
}

function renderDashChart(host, series, revampDate) {
  const section = create('section', 'dash-section');
  section.append(
    create('h2', null, t('dashChartTitle')),
    create('p', 'dash-sub', t('dashChartSub')),
  );
  const box = create('div', 'dash-chartbox');
  const width = Math.max(640, series.length * 46 + 60);
  const height = 240;
  const padL = 48;
  const padB = 26;
  const padT = 14;
  const svg = svgNode('svg', {
    width, height, role: 'img', 'aria-label': t('dashChartTitle'),
  });
  const maxWeighted = Math.max(1, ...series.map((day) => Math.max(
    weightedOf(day),
    // A linha "sem cache" também precisa caber (read a preço cheio = 10×0,1).
    day.input + 1.25 * day.cacheWrite + day.cacheRead + 5 * day.output,
  )));
  const y = (value) => height - padB - (value / maxWeighted) * (height - padB - padT);
  const colors = {
    cacheWrite: 'var(--dash-cachewrite)',
    cacheRead: 'var(--dash-cacheread)',
    input: 'var(--dash-input)',
    output: 'var(--dash-output)',
  };
  // Grade horizontal em quartos do teto.
  for (let grid = 0; grid <= 4; grid += 1) {
    const value = (maxWeighted / 4) * grid;
    svg.append(svgNode('line', {
      x1: padL, y1: y(value), x2: width - 8, y2: y(value),
      stroke: 'var(--border)', 'stroke-width': 0.6,
    }));
    const label = svgNode('text', {
      x: padL - 8, y: y(value) + 4, 'text-anchor': 'end',
      fill: 'var(--muted)', 'font-size': 10, 'font-family': 'var(--mono)',
    });
    label.textContent = compactTokens(value);
    svg.append(label);
  }
  const barWidth = (width - padL - 16) / series.length;
  series.forEach((day, index) => {
    const x = padL + index * barWidth + 4;
    const bw = Math.max(6, barWidth - 9);
    let acc = 0;
    for (const [key, weight] of [['cacheWrite', 1.25], ['cacheRead', 0.1], ['input', 1], ['output', 5]]) {
      const value = day[key] * weight;
      if (value <= 0) continue;
      const top = y(acc + value);
      const segment = svgNode('rect', {
        x, y: top, width: bw, height: Math.max(1, y(acc) - top),
        fill: colors[key], rx: 1.5,
      });
      svg.append(segment);
      acc += value;
    }
    // Hipotético SEM cache: read pagaria preço cheio (peso 1 em vez de 0,1).
    const noCache = day.input + 1.25 * day.cacheWrite + day.cacheRead + 5 * day.output;
    svg.append(svgNode('line', {
      x1: x, y1: y(noCache), x2: x + bw, y2: y(noCache),
      stroke: 'var(--dash-good)', 'stroke-width': 2, 'stroke-dasharray': '4 3',
    }));
    const dayLabel = svgNode('text', {
      x: x + bw / 2, y: height - 9, 'text-anchor': 'middle',
      fill: day.day === revampDate ? 'var(--accent)' : 'var(--muted)',
      'font-size': 10, 'font-family': 'var(--mono)',
    });
    dayLabel.textContent = shortDay(day.day);
    svg.append(dayLabel);
    if (day.day === revampDate) {
      svg.append(svgNode('line', {
        x1: x + bw + 2, y1: padT, x2: x + bw + 2, y2: height - padB,
        stroke: 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
      }));
      const mark = svgNode('text', {
        x: x + bw + 8, y: padT + 10, fill: 'var(--accent)',
        'font-size': 10.5, 'font-weight': 700,
      });
      mark.textContent = `⚡ ${t('dashRevamp')}`;
      svg.append(mark);
    }
  });
  box.append(svg);
  const legend = create('div', 'dash-legend');
  for (const [key, label] of [
    ['cacheWrite', t('dashCacheWrite')], ['cacheRead', t('dashCacheRead')],
    ['input', t('input')], ['output', t('output')],
  ]) {
    const item = create('span');
    const swatch = create('i');
    swatch.style.background = colors[key];
    item.append(swatch, document.createTextNode(label));
    legend.append(item);
  }
  const noCacheItem = create('span');
  const noCacheSwatch = create('i', 'dash-legend-line');
  noCacheItem.append(noCacheSwatch, document.createTextNode(t('dashNoCache')));
  legend.append(noCacheItem);
  box.append(legend);
  section.append(box);
  host.append(section);
}

function renderDashXray(host, series) {
  const section = create('section', 'dash-section dash-xray');
  const left = create('div');
  left.append(
    create('h2', null, t('dashXrayTitle')),
    create('p', 'dash-sub', t('dashXraySub')),
  );
  const list = create('div', 'dash-panel');
  for (const day of [...series].slice(-7).reverse()) {
    const row = create('div', 'dash-xray-row');
    const meter = create('div', 'dash-meter');
    const share = cacheShareOf(day);
    const read = create('b');
    read.style.width = `${Math.round(share * 100)}%`;
    const write = create('i');
    write.style.width = `${Math.round((1 - share) * 100)}%`;
    meter.append(read, write);
    const savings = day.estimated
      ? `${compactTokens(Math.round(day.cacheRead * 0.9))} ${t('tokens')}`
      : usd(savingsUsdOf(day));
    row.append(
      create('span', 'dash-xray-day', shortDay(day.day)),
      meter,
      create('span', 'dash-xray-eco', `+${savings} · ${Math.round(share * 100)}%`),
    );
    list.append(row);
  }
  left.append(list);

  const right = create('div');
  right.append(
    create('h2', null, t('dashFormulasTitle')),
    create('p', 'dash-sub', t('dashFormulasSub')),
  );
  const panel = create('div', 'dash-panel dash-formulas');
  for (const [label, formula] of [
    [t('dashCacheShare'), 'read ÷ (read + write + input)'],
    [t('dashSavings'), 'read × 0,9 × preço de entrada'],
    [t('dashWeighted'), 'input + 1,25×write + 0,1×read + 5×output'],
  ]) {
    const line = create('div', 'dash-formula');
    line.append(create('strong', null, label), create('code', null, formula));
    panel.append(line);
  }
  right.append(panel);
  section.append(left, right);
  host.append(section);
}

function renderDashTable(host, series, revampDate) {
  const section = create('section', 'dash-section');
  section.append(create('h2', null, t('dashSeriesTitle')));
  const box = create('div', 'dash-panel dash-tablebox');
  const table = create('table', 'dash-table');
  const head = create('tr');
  for (const label of [t('dashDay'), t('dashTurns'), t('input'), t('dashCacheWrite'),
    t('dashCacheRead'), t('output'), t('dashCost'), t('dashSavings'), t('dashCacheCol')]) {
    head.append(create('th', null, label));
  }
  table.append(head);
  for (const day of [...series].reverse()) {
    const row = create('tr');
    const dayCell = create('td', 'dash-day-cell', shortDay(day.day));
    if (revampDate && day.day < revampDate) {
      dayCell.append(create('span', 'dash-badge old', t('dashEraOld')));
    }
    row.append(dayCell);
    row.append(create('td', null, number(day.turns)));
    row.append(create('td', null, compactTokens(day.input)));
    row.append(create('td', null, compactTokens(day.cacheWrite)));
    row.append(create('td', null, compactTokens(day.cacheRead)));
    row.append(create('td', null, compactTokens(day.output)));
    row.append(create('td', 'dash-cost', usd(day.costUsd)));
    row.append(create('td', 'dash-eco', day.estimated
      ? compactTokens(Math.round(day.cacheRead * 0.9))
      : usd(savingsUsdOf(day))));
    row.append(create('td', null, `${Math.round(cacheShareOf(day) * 100)}%`));
    table.append(row);
  }
  box.append(table);
  section.append(box);
  host.append(section);
}

/** Ponto de entrada: consumption.js chama com a série normalizada da fonte ativa. */
// eslint-disable-next-line no-unused-vars
function renderDashboard(host, series, { revampDate, error, notConfigured } = {}) {
  host.replaceChildren();
  if (notConfigured) {
    const card = create('div', 'dash-configure');
    card.append(
      create('h2', null, t('dashConfigureTitle')),
      create('p', null, t('dashConfigureHint')),
    );
    const button = create('button', 'dash-configure-button', t('dashOpenSettings'));
    button.type = 'button';
    button.addEventListener('click', () => void windowThis.consumptionApi.openSettings());
    card.append(button);
    host.append(card);
    return;
  }
  if (error) {
    host.append(create('div', 'state-message', `${t('dashError')} (${error})`));
    return;
  }
  if (!Array.isArray(series) || series.length === 0) {
    host.append(create('div', 'state-message', t('noMessages')));
    return;
  }
  renderDashTiles(host, series);
  renderDashChart(host, series, revampDate);
  renderDashXray(host, series);
  renderDashTable(host, series, revampDate);
}
