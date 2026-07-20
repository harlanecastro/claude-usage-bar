const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const SCAN_INTERVAL = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_META_KEY = 'consumption_ingest_retention_days';
const RETENTION_SIZE_META_KEY = 'consumption_ingest_retention_max_mb';
const INGEST_VERSION_META_KEY = 'consumption_ingest_version';
const INGEST_VERSION = 3;
const SYNTHETIC_PROMPT = /^<(?:command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|task-notification)>/i;

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
  if (!clean || SYNTHETIC_PROMPT.test(clean)) return null;
  return clean.slice(0, max);
}

function promptLink(value) {
  if (!value || typeof value !== 'object') return null;
  const text = typeof value.text === 'string' && value.text ? value.text : null;
  const uuid = typeof value.uuid === 'string' && value.uuid ? value.uuid : null;
  if (!text && !uuid) return null;
  return {
    text,
    uuid,
    kind: typeof value.kind === 'string' && value.kind ? value.kind : 'human',
  };
}

function assistantStatus(message) {
  if (!Array.isArray(message?.content)) return null;
  const text = message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
  return compactText(text);
}

function userPrompt(entry, isSubagent) {
  if (entry.isMeta || entry.isCompactSummary || entry.interruptedMessageId != null) return null;
  const message = entry.message;
  if (!message || message.role !== 'user') return null;
  const content = message.content;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((block) => block?.type === 'tool_result')) return null;
    text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => compactText(block.text))
      .filter(Boolean)
      .join(' ');
  }
  const clean = compactText(text);
  if (!clean || /\[Request interrupted by user/i.test(clean)) return null;
  return {
    uuid: entry.uuid || null,
    text: clean,
    kind: isSubagent && !entry.promptSource && !entry.origin ? 'orchestrator_task' : 'human',
  };
}

function subagentInfo(sourcePath) {
  const normalized = sourcePath.split(path.sep).join('/');
  const match = normalized.match(/\/subagents\/agent-([^/]+)\.jsonl$/);
  if (!match) {
    return {
      isSubagent: false,
      agentId: null,
      agentType: null,
      description: null,
      toolUseId: null,
      spawnDepth: 0,
    };
  }

  let meta = null;
  const metaPath = sourcePath.replace(/\.jsonl$/, '.meta.json');
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* optional metadata */ }
  const parsedDepth = Number(meta?.spawnDepth ?? meta?.spawn_depth);
  return {
    isSubagent: true,
    agentId: meta?.agentId || match[1],
    agentType: meta?.agentType || meta?.agent_type || null,
    description: compactText(meta?.description),
    toolUseId: typeof (meta?.toolUseId ?? meta?.tool_use_id) === 'string'
      ? (meta.toolUseId ?? meta.tool_use_id)
      : null,
    // Older metadata has no spawnDepth, but this path still proves depth >= 1.
    spawnDepth: Number.isFinite(parsedDepth) && parsedDepth >= 1 ? parsedDepth : 1,
  };
}

function eventId(sessionId, agentKey, providerKey) {
  return crypto.createHash('sha256')
    .update(`${sessionId}\0${agentKey}\0${providerKey}`)
    .digest('hex');
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
        try { mtimeMs = (await fsp.stat(target)).mtimeMs; } catch { /* file disappeared */ }
        files.push({ path: target, mtimeMs });
      }
    }
  }
  await walk(root);
  // Recent activity must become visible first during an initial import or a
  // parser-version backfill; the full historical pass continues in background.
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .map((file) => file.path);
}

class ConsumptionIngest extends EventEmitter {
  constructor(store, getRetention, root = path.join(os.homedir(), '.claude', 'projects')) {
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
    const persistedRetention = Number(this.store.getMeta?.(RETENTION_META_KEY));
    const persistedRetentionSize = Number(this.store.getMeta?.(RETENTION_SIZE_META_KEY));
    const persistedIngestVersion = Number(this.store.getMeta?.(INGEST_VERSION_META_KEY));
    const configuredRetention = Number(this.getRetention()?.days);
    const configuredRetentionSize = Number(this.getRetention()?.maxMb);
    this.lastRetentionDays = Number.isFinite(persistedRetention) && persistedRetention > 0
      ? persistedRetention
      : (Number.isFinite(configuredRetention) ? configuredRetention : 0);
    this.lastRetentionMaxMb = Number.isFinite(persistedRetentionSize)
        && persistedRetentionSize > 0
      ? persistedRetentionSize
      : (Number.isFinite(configuredRetentionSize) ? configuredRetentionSize : 0);
    this.ingestVersion = Number.isFinite(persistedIngestVersion)
      ? persistedIngestVersion
      : 0;
  }

  start() {
    this.stopped = false;
    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL);
    this.timer.unref?.();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename && String(filename).endsWith('.jsonl')) {
          this.pendingPaths.add(path.join(this.root, String(filename)));
        }
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
      // Recursive watching is unavailable on some filesystems; the periodic
      // scan remains the source of truth.
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
    const configuredRetention = Number(retention?.days);
    const configuredRetentionSize = Number(retention?.maxMb);
    const retentionDays = Number.isFinite(configuredRetention) ? configuredRetention : 0;
    const retentionMaxMb = Number.isFinite(configuredRetentionSize)
      ? configuredRetentionSize
      : 0;
    const forceRescan = retentionDays > this.lastRetentionDays
      || retentionMaxMb > this.lastRetentionMaxMb
      || this.ingestVersion < INGEST_VERSION;
    // A longer retention period must revisit complete transcripts: cursors may
    // already sit after records deliberately skipped by the previous cutoff.
    const targets = !paths || forceRescan ? await jsonlFiles(this.root) : paths;
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
        // Bound first-run growth as well as steady state: a large transcript
        // corpus should not have to finish importing before the size ceiling is
        // enforced.
        const batchPruned = this.store.prune(false);
        if (batchPruned.deleted) changed += batchPruned.deleted;
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
      this.store.setMeta?.(RETENTION_META_KEY, String(retentionDays));
      this.store.setMeta?.(RETENTION_SIZE_META_KEY, String(retentionMaxMb));
      this.store.setMeta?.(INGEST_VERSION_META_KEY, String(INGEST_VERSION));
      this.ingestVersion = INGEST_VERSION;
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
          contentAt: saved.content_at,
          lastSeenAt: now,
        });
      }
      return 0;
    }

    const fileReset = !saved || stat.size < saved.byte_offset
      || (stat.size === saved.file_size && stat.mtimeMs !== saved.mtime_ms);
    const reset = fileReset || forceRescan;
    if (fileReset && saved) {
      this.store.clearSourceAncestry(sourcePath);
      this.store.resetCursor?.(sourcePath);
    }
    const startOffset = reset ? 0 : saved.byte_offset;
    let lineNumber = reset ? 0 : saved.line_number;
    let sessionId = reset ? null : saved.session_id;
    let cwd = reset ? null : saved.cwd;
    let contentAt = reset ? 0 : saved.content_at;
    const agent = subagentInfo(sourcePath);
    let lastPrompt = reset || !saved?.last_prompt ? null : {
      text: saved.last_prompt,
      uuid: saved.last_prompt_uuid,
      kind: saved.last_prompt_kind || (agent.isSubagent ? 'orchestrator_task' : 'human'),
    };

    const promptByUuid = new Map();
    const promptLinks = [];
    const groups = new Map();
    let pending = Buffer.alloc(0);
    const cutoff = now - this.getRetention().days * DAY_MS;

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

          const parsedEntryAt = timestamp(entry.timestamp);
          const entryAt = parsedEntryAt != null && parsedEntryAt <= now + DAY_MS
            ? parsedEntryAt
            : null;
          if (entryAt != null) contentAt = Math.max(contentAt || 0, entryAt);
          sessionId = entry.sessionId || sessionId;
          cwd = entry.cwd || cwd;
          let inheritedPrompt = entry.parentUuid
            ? promptByUuid.get(entry.parentUuid)
            : lastPrompt;
          if (!inheritedPrompt && entry.parentUuid) {
            inheritedPrompt = promptLink(
              this.store.getPromptForEntry(sourcePath, entry.parentUuid),
            );
          }
          const foundPrompt = entry.type === 'user' ? userPrompt(entry, agent.isSubagent) : null;
          const linkedPrompt = foundPrompt || inheritedPrompt;
          if (foundPrompt) {
            lastPrompt = foundPrompt;
          }
          if (entry.uuid && linkedPrompt) {
            promptByUuid.set(entry.uuid, linkedPrompt);
            if (linkedPrompt.uuid && linkedPrompt.text && (entryAt ?? 0) >= cutoff) {
              promptLinks.push({
                sourcePath,
                entryUuid: entry.uuid,
                promptUuid: linkedPrompt.uuid,
                promptText: linkedPrompt.text,
                promptKind: linkedPrompt.kind,
                updatedAt: entryAt ?? now,
              });
            }
          }

          const message = entry.message;
          const isApiError = entry.isApiErrorMessage === true
            || (message?.model === '<synthetic>' && typeof entry.error === 'string');
          if (entry.type !== 'assistant' || !message?.model
              || (!message.usage && !isApiError)
              || (message.model === '<synthetic>' && !isApiError)) continue;
          const endedAt = entryAt;
          if (endedAt == null || endedAt < cutoff || !sessionId) continue;

          const agentId = entry.agentId || agent.agentId;
          const agentKey = agentId || 'main';
          const baseProviderKey = entry.requestId || message.id || entry.uuid;
          if (!baseProviderKey) continue;
          const providerKey = isApiError ? `error:${baseProviderKey}` : baseProviderKey;
          const id = eventId(sessionId, agentKey, providerKey);
          const usage = message.usage || {};
          const cache = usage.cache_creation && typeof usage.cache_creation === 'object'
            ? usage.cache_creation
            : null;
          const cacheCreation = token(usage.cache_creation_input_tokens
            ?? (token(cache?.ephemeral_5m_input_tokens) + token(cache?.ephemeral_1h_input_tokens)));
          const cache5m = cache ? token(cache.ephemeral_5m_input_tokens) : null;
          const cache1h = cache ? token(cache.ephemeral_1h_input_tokens) : null;
          const content = Array.isArray(message.content) ? message.content : [];
          const tools = content
            .filter((block) => block?.type === 'tool_use' && typeof block.name === 'string')
            .map((block) => block.name);
          const kinds = content.map((block) => block?.type).filter(Boolean);
          const old = groups.get(id);
          const projectName = cwd ? path.basename(cwd) : null;
          const serverTools = usage.server_tool_use || {};
          const record = old || {
            id,
            sessionId,
            requestId: entry.requestId || null,
            messageId: message.id || null,
            firstUuid: entry.uuid || null,
            lastUuid: entry.uuid || null,
            sourcePath,
            firstLine: lineNumber,
            lastLine: lineNumber,
            startedAt: endedAt,
            endedAt,
            cwd,
            projectName,
            gitBranch: typeof entry.gitBranch === 'string' ? entry.gitBranch : null,
            promptText: linkedPrompt?.text || null,
            promptUuid: linkedPrompt?.uuid || null,
            agentId: agentId || null,
            agentLabel: agent.description || agentId || 'main',
            agentType: agent.agentType,
            agentDescription: agent.description,
            agentToolUseId: agent.toolUseId,
            spawnDepth: agent.spawnDepth,
            model: message.model,
            stopReason: message.stop_reason || null,
            toolNames: [],
            contentKinds: [],
            eventKind: isApiError ? 'error' : 'usage',
            errorCode: isApiError && typeof entry.error === 'string' ? entry.error : null,
            errorStatus: isApiError && Number.isFinite(Number(entry.apiErrorStatus))
              ? Number(entry.apiErrorStatus)
              : null,
            statusText: isApiError ? assistantStatus(message) : null,
          };

          record.lastUuid = entry.uuid || record.lastUuid;
          record.lastLine = lineNumber;
          record.startedAt = Math.min(record.startedAt, endedAt);
          record.endedAt = Math.max(record.endedAt, endedAt);
          record.promptText = linkedPrompt?.text || record.promptText;
          record.promptUuid = linkedPrompt?.uuid || record.promptUuid;
          record.gitBranch = typeof entry.gitBranch === 'string'
            ? entry.gitBranch
            : record.gitBranch;
          record.toolNames = [...new Set([...record.toolNames, ...tools])];
          record.contentKinds = [...new Set([...record.contentKinds, ...kinds])];
          // Usage records are repeated as a response streams into multiple JSONL
          // lines. The last snapshot is final; summing or taking field-wise MAX
          // would double-count or combine incompatible snapshots.
          record.model = message.model;
          record.stopReason = message.stop_reason || record.stopReason;
          record.eventKind = isApiError ? 'error' : record.eventKind;
          record.errorCode = isApiError && typeof entry.error === 'string'
            ? entry.error
            : record.errorCode;
          record.errorStatus = isApiError && Number.isFinite(Number(entry.apiErrorStatus))
            ? Number(entry.apiErrorStatus)
            : record.errorStatus;
          record.statusText = isApiError ? assistantStatus(message) : record.statusText;
          record.inputTokens = token(usage.input_tokens);
          record.outputTokens = token(usage.output_tokens);
          record.cacheReadTokens = token(usage.cache_read_input_tokens);
          record.cacheCreationTokens = cacheCreation;
          record.cacheCreation5mTokens = cache5m;
          record.cacheCreation1hTokens = cache1h;
          record.cacheCreationUnclassifiedTokens = Math.max(
            0, cacheCreation - token(cache5m) - token(cache1h),
          );
          record.webSearchRequests = token(serverTools.web_search_requests);
          record.webFetchRequests = token(serverTools.web_fetch_requests);
          record.codeExecutionRequests = token(serverTools.code_execution_requests);
          record.serviceTier = usage.service_tier || null;
          record.speed = usage.speed || null;
          record.inferenceGeo = usage.inference_geo || null;
          record.iterations = usage.iterations ?? null;
          record.updatedAt = now;
          groups.set(id, record);
        }
        pending = combined.subarray(from);
      }
    } catch (error) {
      this.scanReadFailed = true;
      console.warn('[consumption] transcript read failed:', sourcePath, error.message);
      return 0;
    }

    const completeOffset = stat.size - pending.length;
    const records = [...groups.values()];
    this.store.insertPromptLinks(promptLinks);
    const changed = this.store.insertRecords(records);
    this.store.saveCursor({
      sourcePath,
      byteOffset: completeOffset,
      lineNumber,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      sessionId,
      cwd,
      lastPrompt: lastPrompt?.text || null,
      lastPromptUuid: lastPrompt?.uuid || null,
      lastPromptKind: lastPrompt?.kind || null,
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
      try { await this.scanning; } catch { /* shutdown is best effort */ }
    }
  }
}

module.exports = { ConsumptionIngest, userPrompt, eventId };
