const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const SCAN_INTERVAL = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_META_KEY = 'codex_ingest_retention_days';
const RETENTION_SIZE_META_KEY = 'codex_ingest_retention_max_mb';
const INGEST_VERSION_META_KEY = 'codex_ingest_version';
const INGEST_VERSION = 2;
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_search_call']);
const TOOL_OUTPUT_TYPES = new Set([
  'function_call_output', 'custom_tool_call_output', 'tool_search_output',
]);

function defaultRoot() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function token(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function timestamp(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function compactText(value, max = 500) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

function messageText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return compactText(content
    .filter((block) => (
      (block?.type === 'input_text' || block?.type === 'output_text')
      && typeof block.text === 'string'
    ))
    .map((block) => block.text)
    .join(' '));
}

function responseItemText(payload) {
  return compactText((Array.isArray(payload?.content) ? payload.content : [])
    .filter((block) => block?.type === 'input_text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' '));
}

function eventId(sessionId, lineNumber) {
  return crypto.createHash('sha256')
    // Codex moves completed rollouts from sessions/ to archived_sessions/.
    // The identity must survive that rename or every archived turn is counted twice.
    .update(`codex\0${sessionId}\0${lineNumber}`)
    .digest('hex');
}

function freshState() {
  return {
    turnId: null,
    turnStartedAt: null,
    promptUuid: null,
    promptLine: null,
    model: null,
    serviceTier: null,
    agentId: null,
    agentLabel: null,
    agentType: null,
    agentDescription: null,
    agentToolUseId: null,
    spawnDepth: 0,
    carryInputLines: [],
    nextInputLines: [],
    pendingFirstLine: null,
    pendingLastLine: null,
    pendingStartedAt: null,
    pendingFirstId: null,
    pendingLastId: null,
    pendingMessageId: null,
    toolNames: [],
    contentKinds: [],
  };
}

function restoredState(raw) {
  if (!raw) return freshState();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return freshState();
    return {
      ...freshState(),
      ...parsed,
      carryInputLines: Array.isArray(parsed.carryInputLines) ? parsed.carryInputLines : [],
      nextInputLines: Array.isArray(parsed.nextInputLines) ? parsed.nextInputLines : [],
      toolNames: Array.isArray(parsed.toolNames) ? parsed.toolNames : [],
      contentKinds: Array.isArray(parsed.contentKinds) ? parsed.contentKinds : [],
    };
  } catch {
    return freshState();
  }
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function resetPending(state) {
  state.carryInputLines = unique(state.nextInputLines);
  state.nextInputLines = [];
  state.pendingFirstLine = null;
  state.pendingLastLine = null;
  state.pendingStartedAt = null;
  state.pendingFirstId = null;
  state.pendingLastId = null;
  state.pendingMessageId = null;
  state.toolNames = [];
  state.contentKinds = [];
}

function noteOutput(state, lineNumber, entryAt, id, kinds = [], tools = []) {
  state.pendingFirstLine ??= lineNumber;
  state.pendingLastLine = lineNumber;
  state.pendingStartedAt ??= entryAt;
  state.pendingFirstId ??= id || null;
  state.pendingLastId = id || state.pendingLastId;
  state.toolNames = unique([...state.toolNames, ...tools]);
  state.contentKinds = unique([...state.contentKinds, ...kinds]);
}

function applySessionMeta(state, payload, previousSessionId) {
  const sessionId = payload?.session_id || payload?.id || previousSessionId;
  if (previousSessionId && sessionId && previousSessionId !== sessionId) {
    Object.assign(state, freshState());
  }
  const spawn = payload?.source?.subagent?.thread_spawn;
  if (spawn) {
    state.agentId = sessionId || null;
    state.agentLabel = compactText(spawn.agent_nickname)
      || compactText(spawn.agent_path)
      || sessionId
      || null;
    state.agentType = compactText(spawn.agent_role);
    state.agentDescription = compactText(spawn.agent_path);
    state.agentToolUseId = null;
    const depth = Number(spawn.depth);
    state.spawnDepth = Number.isFinite(depth) && depth >= 1 ? depth : 1;
  } else {
    state.agentId = null;
    state.agentLabel = null;
    state.agentType = null;
    state.agentDescription = null;
    state.agentToolUseId = null;
    state.spawnDepth = 0;
  }
  return sessionId;
}

async function jsonlFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let mtimeMs = 0;
        try { mtimeMs = (await fsp.stat(target)).mtimeMs; } catch { /* disappeared */ }
        files.push({ path: target, mtimeMs });
      }
    }
  }
  await walk(path.join(root, 'sessions'));
  await walk(path.join(root, 'archived_sessions'));
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .map((file) => file.path);
}

function isTranscript(root, sourcePath) {
  const resolved = path.resolve(String(sourcePath || ''));
  const sessions = path.join(path.resolve(root), 'sessions') + path.sep;
  const archived = path.join(path.resolve(root), 'archived_sessions') + path.sep;
  return resolved.endsWith('.jsonl')
    && (resolved.startsWith(sessions) || resolved.startsWith(archived));
}

class CodexConsumptionIngest extends EventEmitter {
  constructor(store, getRetention, root = defaultRoot()) {
    super();
    this.store = store;
    this.getRetention = getRetention;
    this.root = root;
    this.timer = null;
    this.watcher = null;
    this.debounce = null;
    this.scanning = null;
    this.scanAgain = false;
    this.pendingPaths = new Set();
    this.stopped = false;
    this.scanReadFailed = false;
    const configured = this.getRetention();
    this.lastRetentionDays = Number(this.store.getMeta?.(RETENTION_META_KEY))
      || Number(configured?.days)
      || 0;
    this.lastRetentionMaxMb = Number(this.store.getMeta?.(RETENTION_SIZE_META_KEY))
      || Number(configured?.maxMb)
      || 0;
    this.ingestVersion = Number(this.store.getMeta?.(INGEST_VERSION_META_KEY)) || 0;
  }

  start() {
    this.stopped = false;
    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL);
    this.timer.unref?.();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const target = path.join(this.root, String(filename));
        if (!isTranscript(this.root, target)) return;
        this.pendingPaths.add(target);
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          const paths = this.pendingPaths.size ? [...this.pendingPaths] : null;
          this.pendingPaths.clear();
          this.scan(paths);
        }, 750);
        this.debounce.unref?.();
      });
      this.watcher.on('error', () => {});
    } catch {
      // The periodic scan remains authoritative when recursive watching is unavailable.
    }
  }

  async scan(paths = null) {
    if (this.stopped) return { changed: 0 };
    if (this.scanning) {
      this.scanAgain = true;
      if (paths) paths.forEach((file) => this.pendingPaths.add(file));
      return this.scanning;
    }
    this.scanning = this._scan(paths).finally(async () => {
      this.scanning = null;
      if (this.scanAgain && !this.stopped) {
        this.scanAgain = false;
        const next = this.pendingPaths.size ? [...this.pendingPaths] : null;
        this.pendingPaths.clear();
        await this.scan(next);
      }
    });
    return this.scanning;
  }

  async _scan(paths) {
    const retention = this.getRetention();
    const retentionDays = Number(retention?.days) || 0;
    const retentionMaxMb = Number(retention?.maxMb) || 0;
    const forceRescan = retentionDays > this.lastRetentionDays
      || retentionMaxMb > this.lastRetentionMaxMb
      || this.ingestVersion < INGEST_VERSION;
    const targets = (!paths || forceRescan ? await jsonlFiles(this.root) : paths)
      .filter((file) => isTranscript(this.root, file));
    let changed = 0;
    let notifiedChanges = 0;
    let seen = 0;
    let completed = true;
    this.scanReadFailed = false;
    for (const sourcePath of targets) {
      if (this.stopped) {
        completed = false;
        break;
      }
      changed += await this._scanFile(sourcePath, { forceRescan });
      seen += 1;
      if (seen % 25 === 0) {
        const pruned = this.store.prune(false);
        if (pruned.deleted) changed += pruned.deleted;
        if (changed > notifiedChanges) {
          this.emit('changed');
          notifiedChanges = changed;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (completed && !this.scanReadFailed) {
      this.lastRetentionDays = retentionDays;
      this.lastRetentionMaxMb = retentionMaxMb;
      this.ingestVersion = INGEST_VERSION;
      this.store.setMeta?.(RETENTION_META_KEY, String(retentionDays));
      this.store.setMeta?.(RETENTION_SIZE_META_KEY, String(retentionMaxMb));
      this.store.setMeta?.(INGEST_VERSION_META_KEY, String(INGEST_VERSION));
    }
    const pruned = this.store.prune(false);
    if (pruned.deleted) changed += pruned.deleted;
    if (changed > notifiedChanges) this.emit('changed');
    return { changed, files: seen };
  }

  updateRetention() {
    return this.scan(null);
  }

  async _scanFile(sourcePath, { forceRescan = false } = {}) {
    if (!isTranscript(this.root, sourcePath)) return 0;
    let stat;
    try { stat = await fsp.stat(sourcePath); } catch { return 0; }
    if (!stat.isFile()) return 0;

    const now = Date.now();
    const saved = this.store.getCursor(sourcePath);
    const unchanged = saved
      && saved.file_size === stat.size
      && saved.mtime_ms === stat.mtimeMs;
    if (unchanged && !forceRescan) {
      if (now - saved.last_seen_at > DAY_MS) {
        this.store.saveCursor({
          sourcePath,
          byteOffset: saved.byte_offset,
          lineNumber: saved.line_number,
          fileSize: stat.size,
          mtimeMs: stat.mtimeMs,
          sessionId: saved.session_id,
          cwd: saved.cwd,
          lastPrompt: saved.last_prompt,
          lastPromptUuid: saved.last_prompt_uuid,
          lastPromptKind: saved.last_prompt_kind,
          parserState: saved.parser_state,
          contentAt: saved.content_at,
          lastSeenAt: now,
        });
      }
      return 0;
    }

    const fileReset = !saved || stat.size < saved.byte_offset
      || (stat.size === saved.file_size && stat.mtimeMs !== saved.mtime_ms);
    const reset = fileReset || forceRescan;
    if (fileReset && saved) this.store.resetCursor(sourcePath);
    const startOffset = reset ? 0 : saved.byte_offset;
    let lineNumber = reset ? 0 : saved.line_number;
    let sessionId = reset ? null : saved.session_id;
    let cwd = reset ? null : saved.cwd;
    let promptText = reset ? null : saved.last_prompt;
    let contentAt = reset ? 0 : saved.content_at;
    const state = reset ? freshState() : restoredState(saved.parser_state);
    const records = [];
    const cutoff = now - this.getRetention().days * DAY_MS;
    let pending = Buffer.alloc(0);

    try {
      const stream = stat.size > startOffset
        ? fs.createReadStream(sourcePath, { start: startOffset, end: stat.size - 1 })
        : null;
      for await (const chunk of stream || []) {
        const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let from = 0;
        let newline;
        while ((newline = combined.indexOf(0x0a, from)) !== -1) {
          const line = combined.subarray(from, newline).toString('utf8').trim();
          from = newline + 1;
          lineNumber += 1;
          if (!line) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          const entryAt = timestamp(entry.timestamp);
          if (entryAt != null && entryAt <= now + DAY_MS) {
            contentAt = Math.max(contentAt || 0, entryAt);
          }
          const payload = entry.payload || {};

          if (entry.type === 'session_meta') {
            sessionId = applySessionMeta(state, payload, sessionId);
            cwd = payload.cwd || cwd;
            continue;
          }
          if (entry.type === 'turn_context') {
            state.turnId = payload.turn_id || state.turnId;
            cwd = payload.cwd || cwd;
            state.model = payload.model || state.model;
            continue;
          }
          if (entry.type === 'event_msg' && payload.type === 'thread_settings_applied') {
            const settings = payload.thread_settings || {};
            cwd = settings.cwd || cwd;
            state.model = settings.model || state.model;
            state.serviceTier = settings.service_tier || state.serviceTier;
            continue;
          }
          if (entry.type === 'event_msg' && payload.type === 'task_started') {
            state.turnId = payload.turn_id || state.turnId;
            const seconds = Number(payload.started_at);
            state.turnStartedAt = Number.isFinite(seconds)
              ? seconds * 1000
              : entryAt;
            state.promptUuid = state.turnId;
            state.promptLine = null;
            promptText = null;
            state.carryInputLines = [];
            state.nextInputLines = [];
            resetPending(state);
            continue;
          }
          if (entry.type === 'event_msg' && payload.type === 'user_message') {
            promptText = compactText(payload.message) || promptText;
            state.promptUuid = payload.client_id || state.turnId || state.promptUuid;
            state.promptLine = lineNumber;
            state.carryInputLines = [lineNumber];
            continue;
          }
          if (entry.type === 'response_item' && payload.type === 'message'
              && payload.role === 'user') {
            const candidate = messageText(payload);
            if (candidate) {
              promptText = candidate;
              state.promptUuid = payload.id || state.turnId || state.promptUuid;
              state.promptLine = lineNumber;
              state.carryInputLines = [lineNumber];
            }
            continue;
          }
          if (entry.type === 'response_item' && payload.type === 'agent_message') {
            const agentText = responseItemText(payload);
            if (!state.pendingFirstLine && state.carryInputLines.length === 0) {
              state.carryInputLines = [lineNumber];
              promptText = agentText || promptText;
              state.promptUuid = payload.id || state.turnId || state.promptUuid;
            } else {
              state.nextInputLines.push(lineNumber);
            }
            continue;
          }
          if (entry.type === 'response_item' && TOOL_OUTPUT_TYPES.has(payload.type)) {
            state.nextInputLines.push(lineNumber);
            continue;
          }

          if (entry.type === 'response_item' && TOOL_CALL_TYPES.has(payload.type)) {
            const toolName = payload.type === 'tool_search_call'
              ? 'tool_search'
              : payload.name;
            noteOutput(state, lineNumber, entryAt, payload.id || payload.call_id,
              ['tool_use'], [toolName]);
            state.pendingMessageId = payload.call_id || payload.id || state.pendingMessageId;
            continue;
          }
          if (entry.type === 'response_item' && payload.type === 'reasoning') {
            noteOutput(state, lineNumber, entryAt, payload.id, ['reasoning']);
            continue;
          }
          if (entry.type === 'response_item' && payload.type === 'message'
              && payload.role === 'assistant') {
            const kinds = (Array.isArray(payload.content) ? payload.content : [])
              .map((block) => block?.type === 'output_text' ? 'text' : block?.type)
              .filter(Boolean);
            noteOutput(state, lineNumber, entryAt, payload.id, kinds.length ? kinds : ['text']);
            state.pendingMessageId = payload.id || state.pendingMessageId;
            continue;
          }
          if (entry.type === 'event_msg' && payload.type === 'agent_message') {
            noteOutput(state, lineNumber, entryAt, null, ['text']);
            continue;
          }
          if (entry.type === 'event_msg' && payload.type === 'agent_reasoning') {
            noteOutput(state, lineNumber, entryAt, null, ['reasoning']);
            continue;
          }
          if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue;

          const usage = payload.info?.last_token_usage;
          const endedAt = entryAt;
          if (usage && endedAt != null && endedAt >= cutoff && sessionId) {
            const inputTotal = token(usage.input_tokens);
            const cacheRead = token(usage.cached_input_tokens);
            const cacheWrite = token(usage.cache_write_input_tokens);
            const firstLine = Math.min(
              lineNumber,
              state.pendingFirstLine || lineNumber,
              ...(state.carryInputLines.length ? state.carryInputLines : [lineNumber]),
            );
            records.push({
              id: eventId(sessionId, lineNumber),
              origin: 'codex',
              sessionId,
              requestId: state.turnId ? `${state.turnId}:${lineNumber}` : null,
              messageId: state.pendingMessageId,
              firstUuid: state.pendingFirstId,
              lastUuid: state.pendingLastId,
              sourcePath,
              firstLine,
              lastLine: lineNumber,
              startedAt: state.pendingStartedAt || state.turnStartedAt || endedAt,
              endedAt,
              cwd,
              projectName: cwd ? path.basename(cwd) : null,
              gitBranch: null,
              promptText,
              promptUuid: state.promptUuid || state.turnId,
              agentId: state.agentId,
              agentLabel: state.agentLabel || state.agentId || 'main',
              agentType: state.agentType,
              agentDescription: state.agentDescription,
              agentToolUseId: state.agentToolUseId,
              spawnDepth: state.spawnDepth,
              model: state.model || 'codex',
              stopReason: null,
              toolNames: state.toolNames,
              contentKinds: state.contentKinds,
              inputTokens: Math.max(0, inputTotal - cacheRead - cacheWrite),
              outputTokens: token(usage.output_tokens),
              cacheReadTokens: cacheRead,
              cacheCreationTokens: cacheWrite,
              cacheCreation5mTokens: null,
              cacheCreation1hTokens: null,
              cacheCreationUnclassifiedTokens: cacheWrite,
              webSearchRequests: 0,
              webFetchRequests: 0,
              codeExecutionRequests: 0,
              serviceTier: state.serviceTier,
              speed: null,
              inferenceGeo: null,
              iterations: {
                reasoning_output_tokens: token(usage.reasoning_output_tokens),
                total_tokens: token(usage.total_tokens),
                model_context_window: token(payload.info?.model_context_window),
              },
              eventKind: 'usage',
              errorCode: null,
              errorStatus: null,
              statusText: null,
              updatedAt: now,
            });
          }
          resetPending(state);
        }
        pending = combined.subarray(from);
      }
    } catch (error) {
      this.scanReadFailed = true;
      console.warn('[consumption] Codex transcript read failed:', sourcePath, error.message);
      return 0;
    }

    const completeOffset = stat.size - pending.length;
    const changed = this.store.insertRecords(records);
    this.store.saveCursor({
      sourcePath,
      byteOffset: completeOffset,
      lineNumber,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      sessionId,
      cwd,
      lastPrompt: promptText,
      lastPromptUuid: state.promptUuid,
      lastPromptKind: state.agentId ? 'orchestrator_task' : 'human',
      parserState: JSON.stringify(state),
      contentAt,
      lastSeenAt: now,
    });
    return changed;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.watcher) this.watcher.close();
    this.timer = null;
    this.debounce = null;
    this.watcher = null;
    if (this.scanning) {
      try { await this.scanning; } catch { /* best effort */ }
    }
  }
}

module.exports = { CodexConsumptionIngest, eventId };
