const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ConsumptionStore } = require('../src/main/consumption-store');
const { ConsumptionIngest } = require('../src/main/consumption-ingest');
const { CodexConsumptionIngest } = require('../src/main/codex-consumption-ingest');
const { ConsumptionService } = require('../src/main/consumption-service');
const { readCodexEventContent } = require('../src/main/event-content');
const { normalizePayload, normalizeUsage } = require('../src/main/vps-usage');

function entry(value) {
  return `${JSON.stringify(value)}\n`;
}

test('normalizes cached input semantics by VPS provider', () => {
  assert.deepEqual(normalizeUsage('codex_chatgpt', {
    input_tokens: 187218,
    cache_read_input_tokens: 146176,
    cache_creation_input_tokens: 0,
    output_tokens: 1138,
  }), {
    input_tokens: 41042,
    cache_read_input_tokens: 146176,
    cache_creation_input_tokens: 0,
    output_tokens: 1138,
  });

  assert.equal(normalizeUsage('openai_api', {
    input_tokens: 15342,
    cache_read_input_tokens: 15104,
  }).input_tokens, 238);

  assert.equal(normalizeUsage('claude_code', {
    input_tokens: 41042,
    cache_read_input_tokens: 146176,
  }).input_tokens, 41042);
});

test('normalizes historical VPS rows, turns and details before rendering', () => {
  const daily = normalizePayload('ai_usage', {
    usage: [{
      provider: 'codex_chatgpt',
      input_tokens: 187218,
      cache_read_tokens: 146176,
      cache_write_tokens: 0,
    }],
  });
  assert.equal(daily.usage[0].input_tokens, 41042);

  const turns = normalizePayload('ai_turns', {
    turns: [{
      provider: 'codex_chatgpt',
      usage: { input_tokens: 76814, cache_read_input_tokens: 49664 },
    }],
  });
  assert.equal(turns.turns[0].usage.input_tokens, 27150);

  const detail = normalizePayload('ai_turn_detail', {
    provider: 'openai_api',
    events: [{ usage: { input_tokens: 15342, cache_read_input_tokens: 15104 } }],
  });
  assert.equal(detail.events[0].usage.input_tokens, 238);
});

test('deduplicates streamed assistant blocks and keeps the final usage snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-test-'));
  const dbPath = path.join(root, 'consumption.sqlite3');
  const transcript = path.join(root, 'session.jsonl');
  const retention = { days: 30, maxMb: 100 };
  const store = new ConsumptionStore(dbPath, () => retention);
  const ingest = new ConsumptionIngest(store, () => retention, root);
  const base = Date.now() - 60 * 60 * 1000;
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sessionId = 'session-1';
  const promptUuid = 'user-1';
  fs.writeFileSync(transcript,
    entry({
      type: 'user', uuid: promptUuid, parentUuid: null, sessionId,
      cwd: '/tmp/example', timestamp: new Date(base).toISOString(),
      message: { role: 'user', content: 'Investigue o consumo desta sessão' },
    })
    + entry({
      type: 'assistant', uuid: 'assistant-1a', parentUuid: promptUuid,
      requestId: 'request-1', sessionId, cwd: '/tmp/example',
      timestamp: new Date(base + 60 * 1000).toISOString(),
      message: {
        id: 'message-1', role: 'assistant', model: 'claude-test',
        content: [{ type: 'thinking', thinking: 'hidden' }],
        usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 10 },
      },
    })
    + entry({
      type: 'assistant', uuid: 'assistant-1b', parentUuid: 'assistant-1a',
      requestId: 'request-1', sessionId, cwd: '/tmp/example',
      timestamp: new Date(base + 62 * 1000).toISOString(),
      message: {
        id: 'message-1', role: 'assistant', model: 'claude-test',
        content: [{ type: 'tool_use', name: 'Read', input: { secret: 'not persisted' } }],
        usage: {
          input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100,
          cache_creation_input_tokens: 25,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 5 },
          iterations: [{ output_tokens: 10 }],
        },
      },
    }), 'utf8');

  const changed = await ingest._scanFile(transcript);
  assert.ok(changed > 0);
  store.recordWindow({ kind: 'session', resetsAt: base + 5 * 60 * 60 * 1000, utilization: 50 });
  const page = store.listRecords({
    startAt: base,
    endAt: base + 5 * 60 * 60 * 1000,
  });

  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].origin, 'claude_code');
  assert.equal(page.records[0].outputTokens, 10);
  assert.equal(page.records[0].cacheReadTokens, 100);
  assert.equal(page.records[0].cacheCreation5mTokens, 20);
  assert.equal(page.records[0].cacheCreation1hTokens, 5);
  assert.deepEqual(page.records[0].toolNames, ['Read']);
  assert.equal(page.records[0].promptText, 'Investigue o consumo desta sessão');
  assert.deepEqual(page.records[0].iterations, [{ output_tokens: 10 }]);
  assert.equal(page.records[0].totalTokens, 12);

  const windows = store.listWindows({
    kind: 'session', resetsAt: base + 5 * 60 * 60 * 1000, utilization: 50,
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'observed');
  assert.equal(windows[0].inferred, false);
  assert.equal(windows[0].recordCount, 1);
  assert.equal(windows[0].hours.reduce((sum, hour) => sum + hour.totalTokens, 0), 12);

  store.db.pragma('wal_checkpoint(TRUNCATE)');
  const raw = fs.readFileSync(dbPath);
  assert.equal(raw.includes(Buffer.from('not persisted')), false);
});

test('reads only newly appended complete JSONL lines', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-incremental-'));
  const store = new ConsumptionStore(path.join(root, 'consumption.sqlite3'),
    () => ({ days: 30, maxMb: 100 }));
  const ingest = new ConsumptionIngest(store, () => ({ days: 30, maxMb: 100 }), root);
  const transcript = path.join(root, 'session.jsonl');
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const assistant = {
    type: 'assistant', uuid: 'a1', requestId: 'r1', sessionId: 's1', cwd: '/tmp/p',
    timestamp: new Date().toISOString(),
    message: {
      id: 'm1', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  };
  const serialized = JSON.stringify(assistant);
  fs.writeFileSync(transcript, serialized.slice(0, -1));
  await ingest._scanFile(transcript);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM usage_records').get().count, 0);

  fs.appendFileSync(transcript, `${serialized.slice(-1)}\n`);
  await ingest._scanFile(transcript);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM usage_records').get().count, 1);

  const unchanged = await ingest._scanFile(transcript);
  assert.equal(unchanged, 0);
});

test('resolves prompt ancestry across incremental scans without cursor text', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-ancestry-'));
  const store = new ConsumptionStore(path.join(root, 'consumption.sqlite3'),
    () => ({ days: 30, maxMb: 100 }));
  const ingest = new ConsumptionIngest(store, () => ({ days: 30, maxMb: 100 }), root);
  const transcript = path.join(root, 'session.jsonl');
  const now = Date.now();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(transcript, entry({
    type: 'user', uuid: 'prompt-across-scans', sessionId: 'ancestry-session',
    cwd: '/tmp/ancestry', timestamp: new Date(now).toISOString(),
    message: { role: 'user', content: 'Prompt persistido de forma normalizada' },
  }));
  await ingest._scanFile(transcript);

  const cursor = store.getCursor(transcript);
  store.saveCursor({
    sourcePath: transcript,
    byteOffset: cursor.byte_offset,
    lineNumber: cursor.line_number,
    fileSize: cursor.file_size,
    mtimeMs: cursor.mtime_ms,
    sessionId: cursor.session_id,
    cwd: null,
    lastPrompt: null,
    lastPromptUuid: null,
    contentAt: cursor.content_at,
    lastSeenAt: cursor.last_seen_at,
  });
  const clearedCursor = store.getCursor(transcript);
  assert.equal(clearedCursor.cwd, null);
  assert.equal(clearedCursor.last_prompt, null);
  assert.equal(clearedCursor.last_prompt_uuid, null);

  fs.appendFileSync(transcript, entry({
    type: 'assistant', uuid: 'answer-across-scans', parentUuid: 'prompt-across-scans',
    requestId: 'ancestry-request', sessionId: 'ancestry-session', cwd: '/tmp/ancestry',
    timestamp: new Date(now + 1000).toISOString(),
    message: {
      id: 'ancestry-message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, output_tokens: 3 },
    },
  }));
  await ingest._scanFile(transcript);

  const page = store.listRecords({ startAt: now - 1000, endAt: now + 60 * 1000 });
  assert.equal(page.records[0].promptText, 'Prompt persistido de forma normalizada');
});

test('filters synthetic prompts and exposes subagent usage metadata', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-subagent-'));
  const subagents = path.join(root, 'subagents');
  fs.mkdirSync(subagents);
  const store = new ConsumptionStore(path.join(root, 'consumption.sqlite3'),
    () => ({ days: 30, maxMb: 100 }));
  const ingest = new ConsumptionIngest(store, () => ({ days: 30, maxMb: 100 }), root);
  const transcript = path.join(subagents, 'agent-worker.jsonl');
  const now = Date.now();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(subagents, 'agent-worker.meta.json'), JSON.stringify({
    agentId: 'worker-id', agentType: 'Explore', description: 'Mapear consumidores',
    toolUseId: 'toolu_spawn', spawnDepth: 2,
  }));
  fs.writeFileSync(transcript,
    entry({
      type: 'user', uuid: 'synthetic', sessionId: 'subagent-session',
      timestamp: new Date(now).toISOString(),
      message: { role: 'user', content: '<system-reminder>segredo injetado</system-reminder>' },
    })
    + entry({
      type: 'user', uuid: 'real-prompt', parentUuid: 'synthetic',
      sessionId: 'subagent-session', timestamp: new Date(now + 1).toISOString(),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>ignorar</system-reminder>' },
          { type: 'text', text: 'Investigue este gasto' },
        ],
      },
    })
    + entry({
      type: 'assistant', uuid: 'subagent-answer', parentUuid: 'real-prompt',
      requestId: 'subagent-request', sessionId: 'subagent-session',
      gitBranch: 'feature/consumption-details',
      timestamp: new Date(now + 2).toISOString(),
      message: {
        id: 'subagent-message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: 'não deve ser persistido' }],
        usage: { input_tokens: 4, output_tokens: 5, iterations: [{ input_tokens: 4 }] },
      },
    }));

  await ingest._scanFile(transcript);
  const [record] = store.listRecords({ startAt: now - 1, endAt: now + 1000 }).records;
  assert.equal(record.promptText, 'Investigue este gasto');
  assert.equal(record.agentId, 'worker-id');
  assert.equal(record.agentLabel, 'Mapear consumidores');
  assert.equal(record.agentDescription, 'Mapear consumidores');
  assert.equal(record.agentToolUseId, 'toolu_spawn');
  assert.equal(record.agentType, 'Explore');
  assert.equal(record.spawnDepth, 2);
  assert.equal(record.gitBranch, 'feature/consumption-details');
  assert.deepEqual(record.iterations, [{ input_tokens: 4 }]);
});

test('keeps quota interruptions and paginates every event newest first', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-quota-'));
  const store = new ConsumptionStore(path.join(root, 'consumption.sqlite3'),
    () => ({ days: 30, maxMb: 100 }));
  const ingest = new ConsumptionIngest(store, () => ({ days: 30, maxMb: 100 }), root);
  const transcript = path.join(root, 'quota-session.jsonl');
  const now = Date.now();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(transcript,
    entry({
      type: 'user', uuid: 'first-prompt', sessionId: 'quota-session', cwd: '/tmp/quota',
      timestamp: new Date(now).toISOString(),
      message: { role: 'user', content: 'Primeira solicitação' },
    })
    + entry({
      type: 'assistant', uuid: 'first-answer', parentUuid: 'first-prompt',
      requestId: 'first-request', sessionId: 'quota-session', cwd: '/tmp/quota',
      timestamp: new Date(now + 1000).toISOString(),
      message: {
        id: 'first-message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: 'resposta que não deve ser persistida' }],
        usage: { input_tokens: 7, output_tokens: 8 },
      },
    })
    + entry({
      type: 'user', uuid: 'quota-prompt', parentUuid: 'first-answer',
      sessionId: 'quota-session', cwd: '/tmp/quota',
      timestamp: new Date(now + 2000).toISOString(),
      message: { role: 'user', content: 'Solicitação interrompida pela cota' },
    })
    + entry({
      type: 'assistant', uuid: 'quota-error', parentUuid: 'quota-prompt',
      requestId: 'quota-request', sessionId: 'quota-session', cwd: '/tmp/quota',
      timestamp: new Date(now + 3000).toISOString(), error: 'rate_limit',
      isApiErrorMessage: true, apiErrorStatus: 429,
      message: {
        id: 'quota-message', role: 'assistant', model: '<synthetic>',
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: "You've hit your session limit · resets 8:50pm" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));

  await ingest._scanFile(transcript);
  const firstPage = store.listRecords({
    startAt: now - 1, endAt: now + 10_000, limit: 1,
  });
  assert.equal(firstPage.records.length, 1);
  assert.equal(firstPage.records[0].eventKind, 'error');
  assert.equal(firstPage.records[0].errorCode, 'rate_limit');
  assert.equal(firstPage.records[0].errorStatus, 429);
  assert.equal(firstPage.records[0].statusText,
    "You've hit your session limit · resets 8:50pm");
  assert.equal(firstPage.records[0].promptText, 'Solicitação interrompida pela cota');
  assert.equal(firstPage.records[0].promptUuid, 'quota-prompt');
  assert.equal(firstPage.records[0].totalTokens, 0);
  assert.ok(firstPage.nextCursor);

  const secondPage = store.listRecords({
    startAt: now - 1, endAt: now + 10_000, limit: 1, cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.records.length, 1);
  assert.equal(secondPage.records[0].eventKind, 'usage');
  assert.equal(secondPage.records[0].promptText, 'Primeira solicitação');
  assert.equal(secondPage.records[0].totalTokens, 15);
  assert.equal(secondPage.nextCursor, null);
  assert.ok(firstPage.records[0].endedAt > secondPage.records[0].endedAt);
});

test('backfills complete transcripts after retention is increased', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-backfill-'));
  const retention = { days: 7, maxMb: 100 };
  const store = new ConsumptionStore(path.join(root, 'consumption.sqlite3'), () => retention);
  const ingest = new ConsumptionIngest(store, () => retention, root);
  const transcript = path.join(root, 'backfill.jsonl');
  const now = Date.now();
  const assistant = (id, endedAt) => entry({
    type: 'assistant', uuid: `uuid-${id}`, requestId: `request-${id}`,
    sessionId: 'backfill-session', timestamp: new Date(endedAt).toISOString(),
    message: {
      id: `message-${id}`, role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  fs.writeFileSync(transcript,
    assistant('old', now - 20 * 24 * 60 * 60 * 1000) + assistant('new', now - 1000));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ingest.scan();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_records').get().count, 1);
  retention.days = 30;
  await ingest.updateRetention();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_records').get().count, 2);
});

test('reports the size alert without deleting recent audits and scrubs expired cursor context', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-retention-'));
  const dbPath = path.join(root, 'consumption.sqlite3');
  const retention = { days: 30, maxMb: 1 };
  const store = new ConsumptionStore(dbPath, () => retention);
  const now = Date.now();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const insert = store.db.prepare(`
    INSERT INTO usage_records (
      id, session_id, source_path, first_line, last_line, started_at, ended_at,
      prompt_text, model, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fill = store.db.transaction(() => {
    const payload = 'x'.repeat(4096);
    for (let index = 0; index < 2000; index += 1) {
      insert.run(`large-${index}`, 'large-session', '/tmp/large.jsonl', index, index,
        now + index, now + index, payload, 'claude-test', now);
    }
  });
  fill();

  store.saveCursor({
    sourcePath: '/tmp/old.jsonl', byteOffset: 123, lineNumber: 7,
    fileSize: 123, mtimeMs: now, sessionId: 'old-session', cwd: '/secret/project',
    lastPrompt: 'contexto antigo', lastPromptUuid: 'old-prompt',
    contentAt: now - 31 * 24 * 60 * 60 * 1000, lastSeenAt: now,
  });
  store.insertPromptLinks([{
    sourcePath: '/tmp/old.jsonl', entryUuid: 'old-entry', promptUuid: 'old-prompt',
    promptText: 'contexto antigo', promptKind: 'human',
    updatedAt: now - 31 * 24 * 60 * 60 * 1000,
  }]);
  assert.ok(store.databaseSize() > retention.maxMb * 1024 * 1024);

  const result = store.prune(true);
  const cursor = store.getCursor('/tmp/old.jsonl');
  assert.equal(result.overLimit, true);
  assert.ok(result.sizeBytes > retention.maxMb * 1024 * 1024);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_records').get().count, 2000);
  assert.equal(cursor.byte_offset, 123);
  assert.equal(cursor.session_id, null);
  assert.equal(cursor.cwd, null);
  assert.equal(cursor.last_prompt, null);
  assert.equal(cursor.last_prompt_uuid, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM prompt_ancestry').get().count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM prompts').get().count, 0);
});

test('keeps observed and unclassified windows disjoint', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-windows-'));
  const store = new ConsumptionStore(path.join(root, 'consumption.sqlite3'),
    () => ({ days: 30, maxMb: 100 }));
  const now = Date.now();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const insert = store.db.prepare(`
    INSERT INTO usage_records (
      id, session_id, source_path, first_line, last_line, started_at, ended_at,
      model, input_tokens, output_tokens, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('inside', 's', '/tmp/s.jsonl', 1, 1, now - 60 * 60 * 1000,
    now - 60 * 60 * 1000, 'claude-test', 3, 4, now);
  insert.run('outside', 's', '/tmp/s.jsonl', 2, 2, now - 8 * 60 * 60 * 1000,
    now - 8 * 60 * 60 * 1000, 'claude-test', 5, 6, now);

  const windows = store.listWindows({ kind: 'session', resetsAt: now, utilization: 25 });
  assert.equal(windows.filter((window) => window.kind === 'observed').length, 1);
  assert.ok(windows.some((window) => window.kind === 'unclassified'));
  assert.ok(windows.every((window) => window.inferred === false));
  assert.equal(windows.reduce((sum, window) => sum + window.recordCount, 0), 2);
  assert.equal(windows.reduce((sum, window) => sum + window.totalTokens, 0), 18);
  for (const window of windows) {
    assert.equal(window.hours.reduce((sum, hour) => sum + hour.recordCount, 0),
      window.recordCount);
    assert.equal(window.hours.reduce((sum, hour) => sum + hour.totalTokens, 0),
      window.totalTokens);
  }
  for (let left = 0; left < windows.length; left += 1) {
    for (let right = left + 1; right < windows.length; right += 1) {
      assert.equal(
        windows[left].startAt < windows[right].endAt
          && windows[right].startAt < windows[left].endAt,
        false,
      );
    }
  }
});

test('imports in a worker while the main process keeps a read connection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-worker-'));
  const claudeRoot = path.join(root, 'claude');
  const codexRoot = path.join(root, 'codex');
  fs.mkdirSync(claudeRoot);
  fs.mkdirSync(path.join(codexRoot, 'sessions'), { recursive: true });
  const dbPath = path.join(root, 'consumption.sqlite3');
  const retention = { days: 30, maxMb: 100 };
  const store = new ConsumptionStore(dbPath, () => retention);
  const transcript = path.join(claudeRoot, 'worker-session.jsonl');
  const now = Date.now();
  fs.writeFileSync(transcript, entry({
    type: 'assistant', uuid: 'worker-a1', requestId: 'worker-r1',
    sessionId: 'worker-s1', cwd: '/tmp/worker-project', timestamp: new Date(now).toISOString(),
    message: {
      id: 'worker-m1', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 4 },
    },
  }));
  fs.writeFileSync(path.join(codexRoot, 'sessions', 'rollout-worker.jsonl'), [
    {
      timestamp: new Date(now + 1).toISOString(), type: 'session_meta',
      payload: { session_id: 'worker-codex', cwd: '/tmp/codex-worker' },
    },
    {
      timestamp: new Date(now + 2).toISOString(), type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'worker-codex-turn', started_at: now / 1000 },
    },
    {
      timestamp: new Date(now + 3).toISOString(), type: 'turn_context',
      payload: { turn_id: 'worker-codex-turn', model: 'gpt-worker', cwd: '/tmp/codex-worker' },
    },
    {
      timestamp: new Date(now + 4).toISOString(), type: 'event_msg',
      payload: { type: 'user_message', client_id: 'worker-codex-prompt', message: 'Codex worker' },
    },
    {
      timestamp: new Date(now + 5).toISOString(), type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 11, cached_input_tokens: 6, cache_write_input_tokens: 0,
            output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 13,
          },
        },
      },
    },
  ].map(entry).join(''));
  const service = new ConsumptionService({
    dbPath, retention, transcriptRoot: claudeRoot, codexRoot,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await service.scan();
  const page = store.listRecords({ startAt: now - 1000, endAt: now + 60 * 1000 });
  assert.equal(page.records.length, 2);
  assert.deepEqual(new Set(page.records.map((record) => record.origin)),
    new Set(['claude_code', 'codex']));
  assert.equal(page.records.reduce((sum, record) => sum + record.totalTokens, 0), 14);

  const stopping = service.stop();
  await assert.rejects(service.scan(), /ConsumptionWorkerStopping/);
  await stopping;
});

test('imports Codex token deltas, preserves incremental state and exposes event content', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-codex-'));
  const sessions = path.join(root, 'sessions', '2026', '07', '25');
  fs.mkdirSync(sessions, { recursive: true });
  const dbPath = path.join(root, 'consumption.sqlite3');
  const transcript = path.join(sessions, 'rollout-test.jsonl');
  const retention = { days: 30, maxMb: 100 };
  const store = new ConsumptionStore(dbPath, () => retention);
  const ingest = new CodexConsumptionIngest(store, () => retention, root);
  const now = Date.now() - 60_000;
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const firstPart = [
    {
      timestamp: new Date(now).toISOString(), type: 'session_meta',
      payload: {
        session_id: 'codex-session', cwd: '/tmp/codex-project',
        originator: 'Codex Desktop', source: 'vscode', thread_source: 'user',
      },
    },
    {
      timestamp: new Date(now + 1).toISOString(), type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'codex-turn', started_at: now / 1000 },
    },
    {
      timestamp: new Date(now + 2).toISOString(), type: 'turn_context',
      payload: { turn_id: 'codex-turn', cwd: '/tmp/codex-project', model: 'gpt-test' },
    },
    {
      timestamp: new Date(now + 3).toISOString(), type: 'response_item',
      payload: {
        type: 'message', id: 'codex-user', role: 'user',
        content: [{ type: 'input_text', text: 'Analise o consumo do Codex' }],
      },
    },
    {
      timestamp: new Date(now + 4).toISOString(), type: 'event_msg',
      payload: {
        type: 'user_message', client_id: 'codex-prompt',
        message: 'Analise o consumo do Codex',
      },
    },
    {
      timestamp: new Date(now + 5).toISOString(), type: 'event_msg',
      payload: { type: 'agent_message', message: 'Vou analisar.', phase: 'commentary' },
    },
    {
      timestamp: new Date(now + 6).toISOString(), type: 'response_item',
      payload: {
        type: 'custom_tool_call', id: 'codex-call', call_id: 'call-1',
        name: 'apply_patch', input: '*** Begin Patch',
      },
    },
    {
      timestamp: new Date(now + 7).toISOString(), type: 'response_item',
      payload: {
        type: 'custom_tool_call_output', id: 'codex-output', call_id: 'call-1',
        output: 'resultado da ferramenta',
      },
    },
  ].map(entry).join('');
  fs.writeFileSync(transcript, firstPart);
  await ingest._scanFile(transcript);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM usage_records').get().count, 0);

  const remaining = [
    {
      timestamp: new Date(now + 8).toISOString(), type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5,
            output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110,
          },
          model_context_window: 200000,
        },
      },
    },
    {
      timestamp: new Date(now + 9).toISOString(), type: 'response_item',
      payload: {
        type: 'reasoning', id: 'codex-reasoning',
        summary: [{ type: 'summary_text', text: 'Conferindo os dados' }],
      },
    },
    {
      timestamp: new Date(now + 10).toISOString(), type: 'event_msg',
      payload: { type: 'agent_message', message: 'Análise concluída.', phase: 'final_answer' },
    },
    {
      timestamp: new Date(now + 11).toISOString(), type: 'response_item',
      payload: {
        type: 'message', id: 'codex-answer', role: 'assistant',
        content: [{ type: 'output_text', text: 'Análise concluída.' }],
      },
    },
    {
      timestamp: new Date(now + 12).toISOString(), type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 120, cached_input_tokens: 100, cache_write_input_tokens: 0,
            output_tokens: 20, reasoning_output_tokens: 4, total_tokens: 140,
          },
          model_context_window: 200000,
        },
      },
    },
  ].map(entry).join('');
  fs.appendFileSync(transcript, remaining);
  await ingest._scanFile(transcript);

  const page = store.listRecords({ startAt: now - 1, endAt: now + 60_000 });
  assert.equal(page.records.length, 2);
  const [second, first] = page.records;
  assert.equal(first.origin, 'codex');
  assert.equal(first.model, 'gpt-test');
  assert.equal(first.promptText, 'Analise o consumo do Codex');
  assert.equal(first.inputTokens, 35);
  assert.equal(first.cacheReadTokens, 60);
  assert.equal(first.cacheCreationTokens, 5);
  assert.equal(first.outputTokens, 10);
  assert.deepEqual(first.toolNames, ['apply_patch']);
  assert.equal(second.inputTokens, 20);
  assert.equal(second.cacheReadTokens, 100);
  assert.equal(second.outputTokens, 20);
  assert.equal(second.promptUuid, first.promptUuid);
  const [daily] = store.summarizeDaily(30);
  assert.equal(daily.origin, 'codex');
  assert.equal(daily.turns, 2);

  const firstLocation = store.getRecordLocation(first.id);
  const firstIo = readCodexEventContent(
    fs.readFileSync(transcript, 'utf8'), firstLocation.first_line, firstLocation.last_line,
  );
  assert.equal(firstIo.input[0].text, 'Analise o consumo do Codex');
  assert.ok(firstIo.output.some((block) => (
    block.kind === 'tool_use' && block.name === 'apply_patch'
  )));
  assert.equal(firstIo.input.some((block) => block.text.includes('resultado da ferramenta')), false);

  const secondLocation = store.getRecordLocation(second.id);
  const secondIo = readCodexEventContent(
    fs.readFileSync(transcript, 'utf8'), secondLocation.first_line, secondLocation.last_line,
  );
  assert.ok(secondIo.input.some((block) => block.text.includes('resultado da ferramenta')));
  assert.ok(secondIo.output.some((block) => block.text.includes('Análise concluída.')));

  const archived = path.join(root, 'archived_sessions', 'rollout-test.jsonl');
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(transcript, archived);
  await ingest._scanFile(archived);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM usage_records').get().count, 2);
  assert.equal(store.getRecordLocation(first.id).source_path, archived);
});
