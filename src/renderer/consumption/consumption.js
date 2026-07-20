'use strict';

const PAGE_SIZE = 1000;
const HOUR_MS = 60 * 60 * 1000;

const fallback = {
  title: 'Detalhes do consumo', window: 'Janela temporal', timeline: 'Linha do tempo',
  allWindow: 'Toda a janela', messagesProcessed: 'Mensagens processadas',
  messagesBetween: 'Mensagens entre {start} e {end}', time: 'Horário',
  message: 'Mensagem', event: 'Evento', input: 'Entrada', output: 'Saída', total: 'Total',
  totalInputOutput: 'Total de entrada + saída', inputOutputSummary: 'entrada e saída somadas por mensagem',
  loading: 'Carregando o histórico…', noWindows: 'Nenhuma janela temporal foi registrada ainda.',
  noMessages: 'Sem mensagem neste período.', unavailable: 'O histórico de consumo não pôde ser aberto.',
  current: 'atual', unclassified: 'limites não confirmados', noMessageCount: 'Sem mensagem',
  messageSingular: 'mensagem', messagePlural: 'mensagens', noRecordCount: 'Sem registro',
  record: 'registro', records: 'registros', groupedSingular: 'agrupado',
  groupedPlural: 'agrupados', tokens: 'tokens',
  mainAgent: 'Agente principal', subagent: 'Subagente', response: 'Resposta do Claude',
  thinking: 'Processamento do Claude', apiError: 'Evento de erro do Claude Code',
  tools: 'Ferramentas: {names}', errorCode: 'Erro', httpStatus: 'HTTP',
  project: 'Projeto', branch: 'Branch', model: 'Modelo', depth: 'Profundidade',
  sessionId: 'Sessão', requestId: 'Requisição', messageId: 'Mensagem', recordId: 'Registro',
};

const state = {
  strings: fallback,
  locale: 'pt-BR',
  windows: [],
  selectedWindow: null,
  selectedHour: null,
  records: [],
  loading: true,
  error: null,
  generation: 0,
  requestedRange: null,
};

const windowThis = globalThis.window;
const windowSelect = document.querySelector('#windowSelect');
const timeline = document.querySelector('#timeline');
const allHours = document.querySelector('#allHours');
const messageGroups = document.querySelector('#messageGroups');
const tableScroll = document.querySelector('#tableScroll');

function t(key, values = {}) {
  let result = state.strings[key] || fallback[key] || key;
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}

function applyStrings() {
  document.documentElement.lang = state.locale;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
}

let intlCache = null;

function formatters() {
  if (intlCache?.locale === state.locale) return intlCache;
  intlCache = {
    locale: state.locale,
    number: new Intl.NumberFormat(state.locale),
    time: new Intl.DateTimeFormat(state.locale, { hour: '2-digit', minute: '2-digit' }),
    timeSeconds: new Intl.DateTimeFormat(state.locale, {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }),
    dateTime: new Intl.DateTimeFormat(state.locale, {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }),
    windowDate: new Intl.DateTimeFormat(state.locale, {
      weekday: 'short', day: '2-digit', month: 'short',
    }),
  };
  return intlCache;
}

function number(value) {
  return formatters().number.format(Number(value) || 0);
}

function time(value, seconds = false) {
  return formatters()[seconds ? 'timeSeconds' : 'time'].format(new Date(value));
}

function dateTime(value) {
  return formatters().dateTime.format(new Date(value));
}

function messageCountText(value) {
  const count = Math.max(0, Number(value) || 0);
  if (count === 0) return t('noMessageCount');
  return `${number(count)} ${t(count === 1 ? 'messageSingular' : 'messagePlural')}`;
}

function recordCountText(value) {
  const count = Math.max(0, Number(value) || 0);
  if (count === 0) return t('noRecordCount');
  return `${number(count)} ${t(count === 1 ? 'record' : 'records')}`;
}

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function recordTotal(record) {
  return (Number(record.inputTokens) || 0) + (Number(record.outputTokens) || 0);
}

function totalOf(records) {
  return records.reduce((sum, record) => sum + recordTotal(record), 0);
}

function windowKey(item) {
  return item ? `${item.startAt}:${item.endAt}:${item.kind || ''}` : '';
}

function windowLabel(item) {
  const date = formatters().windowDate.format(new Date(item.startAt));
  const qualifiers = [];
  if (item.current) qualifiers.push(t('current'));
  if (item.kind === 'unclassified') qualifiers.push(t('unclassified'));
  const suffix = qualifiers.length ? ` · ${qualifiers.join(' · ')}` : '';
  const end = item.endAt - item.startAt > 24 * HOUR_MS ? dateTime(item.endAt) : time(item.endAt);
  return `${date}, ${time(item.startAt)}–${end}${suffix}`;
}

function messageGroupKey(record) {
  const session = record.sessionId || 'session-unknown';
  if (record.promptUuid) return `${session}\u0000prompt:${record.promptUuid}`;
  return `${session}\u0000event:${record.requestId || record.messageId || record.id}`;
}

function agentName(record) {
  return record.agentId ? (record.agentLabel || t('subagent')) : t('mainAgent');
}

function groupRecords(records) {
  const grouped = new Map();
  for (const record of records) {
    const key = messageGroupKey(record);
    let group = grouped.get(key);
    if (!group) {
      group = {
        key,
        promptText: record.promptText,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        inputTokens: 0,
        outputTokens: 0,
        records: [],
        agents: new Set(),
        projects: new Set(),
        branches: new Set(),
        models: new Set(),
        sessions: new Set(),
      };
      grouped.set(key, group);
    }
    group.promptText ||= record.promptText;
    group.startedAt = Math.min(group.startedAt, record.startedAt);
    group.endedAt = Math.max(group.endedAt, record.endedAt);
    group.inputTokens += Number(record.inputTokens) || 0;
    group.outputTokens += Number(record.outputTokens) || 0;
    group.records.push(record);
    group.agents.add(agentName(record));
    if (record.projectName) group.projects.add(record.projectName);
    if (record.gitBranch) group.branches.add(record.gitBranch);
    if (record.model) group.models.add(record.model);
    if (record.sessionId) group.sessions.add(record.sessionId);
  }
  return [...grouped.values()]
    .map((group) => ({
      ...group,
      totalTokens: group.inputTokens + group.outputTokens,
      records: group.records.sort((left, right) => right.endedAt - left.endedAt
        || String(right.id).localeCompare(String(left.id))),
    }))
    .sort((left, right) => right.endedAt - left.endedAt || right.key.localeCompare(left.key));
}

function recordsForSelection() {
  if (!state.selectedHour) return state.records;
  return state.records.filter((record) => (
    record.endedAt >= state.selectedHour.startAt && record.endedAt < state.selectedHour.endAt
  ));
}

function hourBuckets() {
  if (!state.selectedWindow) return [];
  const buckets = new Map();
  for (const record of state.records) {
    const hour = new Date(record.endedAt);
    hour.setMinutes(0, 0, 0);
    const startAt = Math.max(hour.getTime(), state.selectedWindow.startAt);
    const endAt = Math.min(hour.getTime() + HOUR_MS, state.selectedWindow.endAt);
    if (endAt <= startAt) continue;
    const key = `${startAt}:${endAt}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { startAt, endAt, records: [], messageKeys: new Set(), totalTokens: 0 };
      buckets.set(key, bucket);
    }
    bucket.records.push(record);
    bucket.messageKeys.add(messageGroupKey(record));
    bucket.totalTokens += recordTotal(record);
  }
  return [...buckets.values()]
    .map((bucket) => ({
      startAt: bucket.startAt,
      endAt: bucket.endAt,
      messageCount: bucket.messageKeys.size,
      totalTokens: bucket.totalTokens,
    }))
    .filter((bucket) => bucket.messageCount > 0)
    .sort((left, right) => right.startAt - left.startAt);
}

function sameHour(left, right) {
  return Boolean(left && right && left.startAt === right.startAt && left.endAt === right.endAt);
}

function bucketLabel(bucket) {
  const longWindow = state.selectedWindow.endAt - state.selectedWindow.startAt > 24 * HOUR_MS;
  return longWindow
    ? `${dateTime(bucket.startAt)}–${time(bucket.endAt)}`
    : `${time(bucket.startAt)}–${time(bucket.endAt)}`;
}

function renderWindowPicker() {
  windowSelect.replaceChildren();
  for (const item of state.windows) {
    const option = document.createElement('option');
    option.value = windowKey(item);
    option.textContent = `${windowLabel(item)} · ${number(item.totalTokens)} ${t('tokens')}`;
    windowSelect.append(option);
  }
  windowSelect.disabled = !state.selectedWindow || state.loading;
  if (state.selectedWindow) windowSelect.value = windowKey(state.selectedWindow);
}

function renderTimeline() {
  timeline.replaceChildren();
  if (!state.selectedWindow) {
    document.querySelector('#timelineRange').textContent = '';
    document.querySelector('#windowTotal').textContent = '0';
    document.querySelector('#windowMessageCount').textContent = t('noMessageCount');
    allHours.classList.add('selected');
    return;
  }

  const longWindow = state.selectedWindow.endAt - state.selectedWindow.startAt > 24 * HOUR_MS;
  document.querySelector('#timelineRange').textContent = longWindow
    ? `${dateTime(state.selectedWindow.startAt)}–${dateTime(state.selectedWindow.endAt)}`
    : `${time(state.selectedWindow.startAt)}–${time(state.selectedWindow.endAt)}`;
  const allGroups = groupRecords(state.records);
  document.querySelector('#windowTotal').textContent = number(totalOf(state.records));
  document.querySelector('#windowMessageCount').textContent = messageCountText(allGroups.length);
  allHours.classList.toggle('selected', state.selectedHour == null);

  for (const bucket of hourBuckets()) {
    const button = create('button', 'hour');
    button.type = 'button';
    if (sameHour(state.selectedHour, bucket)) button.classList.add('selected');
    button.append(
      create('span', 'hour-time', bucketLabel(bucket)),
      create('b', 'hour-total', number(bucket.totalTokens)),
      create('span', 'hour-count', messageCountText(bucket.messageCount)),
    );
    button.addEventListener('click', () => {
      state.selectedHour = bucket;
      renderTimeline();
      renderMessages();
      tableScroll.scrollTop = 0;
    });
    timeline.append(button);
  }
}

function activityFor(record) {
  if (record.eventKind === 'error') return record.statusText || t('apiError');
  const tools = Array.isArray(record.toolNames) ? record.toolNames : [];
  const contentKinds = Array.isArray(record.contentKinds) ? record.contentKinds : [];
  if (tools.length) return tools.join(', ');
  if (contentKinds.includes('text')) return t('response');
  return t('thinking');
}

function eventContext(record) {
  return [
    agentName(record),
    record.agentType,
    record.spawnDepth != null ? `${t('depth')}: ${record.spawnDepth}` : null,
    record.speed,
    record.serviceTier,
    record.inferenceGeo,
  ].filter(Boolean).join(' · ');
}

function appendIdentifier(host, label, value) {
  if (value == null || value === '') return;
  const line = create('small', 'identifier');
  line.append(create('span', null, `${label}:`), document.createTextNode(` ${value}`));
  host.append(line);
}

function appendEvent(host, record) {
  const row = create('div', `event${record.eventKind === 'error' ? ' error' : ''}`);
  const copy = create('span', 'event-copy');
  copy.append(
    create('strong', null, activityFor(record)),
    create('small', 'event-context', eventContext(record)),
  );
  appendIdentifier(copy, t('requestId'), record.requestId);
  appendIdentifier(copy, t('messageId'), record.messageId);
  appendIdentifier(copy, t('recordId'), record.id);
  appendIdentifier(copy, t('errorCode'), record.errorCode);
  appendIdentifier(copy, t('httpStatus'), record.errorStatus);
  row.append(
    create('span', null, time(record.endedAt, true)),
    copy,
    create('span', null, number(record.inputTokens)),
    create('span', null, number(record.outputTokens)),
    create('span', 'event-total', number(recordTotal(record))),
  );
  host.append(row);
}

function appendGroupMetadata(host, label, values) {
  const item = create('div', 'metadata-item');
  item.append(
    create('span', null, label),
    create('strong', null, values.size ? [...values].join(', ') : '—'),
  );
  host.append(item);
}

function appendMessageGroup(group) {
  const details = create('details', 'message-group');
  const summary = create('summary', 'message-summary');
  const copy = create('span', 'message-copy');
  copy.append(create('strong', null, group.promptText || group.records[0]?.projectName
    || group.records[0]?.sessionId || group.key));
  const agents = [...group.agents].filter(Boolean);
  copy.append(create('small', null,
    `${recordCountText(group.records.length)} ${t(group.records.length === 1
      ? 'groupedSingular' : 'groupedPlural')} · ${agents.join(' + ')}`));
  const error = group.records.find((record) => record.eventKind === 'error');
  if (error) copy.append(create('small', 'status-error', error.statusText || t('apiError')));

  summary.append(
    create('span', 'message-time', time(group.endedAt, true)),
    copy,
    create('span', 'metric', number(group.inputTokens)),
    create('span', 'metric', number(group.outputTokens)),
    create('span', 'metric total', number(group.totalTokens)),
    create('span', 'chevron', '›'),
  );

  const expanded = create('div', 'message-expanded');
  const metadata = create('div', 'message-metadata');
  appendGroupMetadata(metadata, t('project'), group.projects);
  appendGroupMetadata(metadata, t('branch'), group.branches);
  appendGroupMetadata(metadata, t('model'), group.models);
  appendGroupMetadata(metadata, t('sessionId'), group.sessions);

  const events = create('div', 'event-list');
  const header = create('div', 'event-header');
  for (const label of [t('time'), t('event'), t('input'), t('output'), t('total')]) {
    header.append(create('span', null, label));
  }
  events.append(header);
  for (const record of group.records) appendEvent(events, record);
  expanded.append(metadata, events);
  details.append(summary, expanded);
  messageGroups.append(details);
}

function showStateMessage(text) {
  messageGroups.replaceChildren(create('div', 'state-message', text));
}

function renderMessages() {
  const title = document.querySelector('#detailTitle');
  const summary = document.querySelector('#detailSummary');
  const total = document.querySelector('#filteredTotal');

  if (state.loading) {
    title.textContent = t('loading');
    summary.textContent = '';
    total.textContent = '';
    showStateMessage(t('loading'));
    return;
  }
  if (state.error) {
    title.textContent = t('unavailable');
    summary.textContent = '';
    total.textContent = '';
    showStateMessage(t('unavailable'));
    return;
  }
  if (!state.selectedWindow) {
    title.textContent = t('noWindows');
    summary.textContent = '';
    total.textContent = '';
    showStateMessage(t('noWindows'));
    return;
  }

  title.textContent = state.selectedHour
    ? t('messagesBetween', { start: time(state.selectedHour.startAt), end: time(state.selectedHour.endAt) })
    : t('messagesProcessed');

  const records = recordsForSelection();
  const groups = groupRecords(records);
  summary.textContent = `${messageCountText(groups.length)} · ${t('inputOutputSummary')}`;
  total.textContent = `${number(totalOf(records))} ${t('tokens')}`;
  messageGroups.replaceChildren();
  if (!groups.length) {
    showStateMessage(t('noMessages'));
    return;
  }
  groups.forEach(appendMessageGroup);
}

async function requestPage(selectedWindow, cursor = null) {
  const page = await windowThis.consumptionApi.records({
    startAt: selectedWindow.startAt,
    endAt: selectedWindow.endAt,
    cursor,
    limit: PAGE_SIZE,
  });
  if (!page || !Array.isArray(page.records)) throw new Error('InvalidConsumptionPage');
  return page;
}

async function loadAllRecords(selectedWindow, generation) {
  const records = [];
  const ids = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const page = await requestPage(selectedWindow, cursor);
    if (generation !== state.generation) return null;
    for (const record of page.records) {
      if (!ids.has(record.id)) {
        ids.add(record.id);
        records.push(record);
      }
    }
    const next = page.nextCursor || null;
    if (next && cursor && next.endedAt === cursor.endedAt && next.id === cursor.id) {
      throw new Error('RepeatedConsumptionCursor');
    }
    cursor = next;
    pages += 1;
    if (pages > 10000) throw new Error('ConsumptionPageLimit');
  } while (cursor);
  return records.sort((left, right) => right.endedAt - left.endedAt
    || String(right.id).localeCompare(String(left.id)));
}

function preferredWindow(windows, previous) {
  const requested = state.requestedRange;
  const selected = windows.find((item) => requested
    && item.startAt === requested.startAt && item.endAt === requested.endAt);
  if (selected) state.requestedRange = null;
  return selected
    || windows.find((item) => previous && windowKey(item) === windowKey(previous))
    || windows.find((item) => item.current)
    || windows[0]
    || null;
}

async function loadWindow(selectedWindow, previousHour = null) {
  const generation = ++state.generation;
  state.selectedWindow = selectedWindow;
  state.selectedHour = null;
  state.records = [];
  state.loading = Boolean(selectedWindow);
  state.error = null;
  renderWindowPicker();
  renderTimeline();
  renderMessages();
  tableScroll.scrollTop = 0;
  if (!selectedWindow) return;
  try {
    const records = await loadAllRecords(selectedWindow, generation);
    if (generation !== state.generation || !records) return;
    state.records = records;
    state.selectedHour = previousHour
      ? hourBuckets().find((bucket) => sameHour(bucket, previousHour)) || null
      : null;
    state.loading = false;
    renderWindowPicker();
    renderTimeline();
    renderMessages();
  } catch (error) {
    if (generation !== state.generation) return;
    state.loading = false;
    state.error = error;
    renderWindowPicker();
    renderTimeline();
    renderMessages();
  }
}

async function reload() {
  const previousWindow = state.selectedWindow;
  const previousHour = state.selectedHour;
  try {
    const overview = await windowThis.consumptionApi.overview();
    if (overview?.error) throw new Error(overview.error);
    state.strings = { ...fallback, ...(overview?.strings || {}) };
    state.locale = overview?.locale || 'pt-BR';
    state.windows = Array.isArray(overview?.windows) ? overview.windows : [];
    applyStrings();
    await loadWindow(preferredWindow(state.windows, previousWindow), previousHour);
  } catch (error) {
    state.generation += 1;
    state.windows = [];
    state.selectedWindow = null;
    state.selectedHour = null;
    state.records = [];
    state.loading = false;
    state.error = error;
    applyStrings();
    renderWindowPicker();
    renderTimeline();
    renderMessages();
  }
}

windowSelect.addEventListener('change', () => {
  const selected = state.windows.find((item) => windowKey(item) === windowSelect.value) || null;
  if (selected) void loadWindow(selected);
});

allHours.addEventListener('click', () => {
  if (!state.selectedWindow || state.selectedHour == null) return;
  state.selectedHour = null;
  renderTimeline();
  renderMessages();
  tableScroll.scrollTop = 0;
});

if (!windowThis.consumptionApi) {
  state.loading = false;
  state.error = new Error('ConsumptionUnavailable');
  applyStrings();
  renderWindowPicker();
  renderTimeline();
  renderMessages();
} else {
  let changedTimer = null;
  windowThis.consumptionApi.onChanged(() => {
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => void reload(), 500);
  });
  windowThis.consumptionApi.onSelectWindow((range) => {
    state.requestedRange = { startAt: Number(range?.startAt), endAt: Number(range?.endAt) };
    const selected = state.windows.find((item) => (
      item.startAt === state.requestedRange.startAt && item.endAt === state.requestedRange.endAt
    ));
    if (selected) {
      state.requestedRange = null;
      void loadWindow(selected);
    }
  });
  applyStrings();
  renderMessages();
  void reload();
}
