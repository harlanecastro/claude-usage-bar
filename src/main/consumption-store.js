const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const WINDOW_MS = 5 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const totalSql = `
  input_tokens + output_tokens
`;

function jsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonValue(value) {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function uniqueStrings(...lists) {
  return [...new Set(lists.flat().filter((item) => typeof item === 'string' && item))];
}

class ConsumptionStore {
  constructor(dbPath, getRetention) {
    this.dbPath = dbPath;
    this.getRetention = getRetention;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const isNew = !fs.existsSync(dbPath);
    this.db = new Database(dbPath);
    if (isNew) this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_size_limit = 4194304');
    this._createSchema();
    this._prepare();
    this.windowCache = null;
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_windows (
        reset_at INTEGER PRIMARY KEY,
        start_at INTEGER NOT NULL,
        utilization REAL,
        observed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS transcript_cursors (
        source_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        line_number INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        session_id TEXT,
        cwd TEXT,
        last_prompt TEXT,
        last_prompt_uuid TEXT,
        last_prompt_kind TEXT,
        content_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompts (
        uuid TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_ancestry (
        source_path TEXT NOT NULL,
        entry_uuid TEXT NOT NULL,
        prompt_uuid TEXT NOT NULL,
        prompt_kind TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(source_path, entry_uuid),
        FOREIGN KEY(prompt_uuid) REFERENCES prompts(uuid) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_id TEXT,
        message_id TEXT,
        first_uuid TEXT,
        last_uuid TEXT,
        source_path TEXT NOT NULL,
        first_line INTEGER NOT NULL,
        last_line INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        cwd TEXT,
        project_name TEXT,
        git_branch TEXT,
        prompt_text TEXT,
        prompt_uuid TEXT,
        agent_id TEXT,
        agent_label TEXT NOT NULL DEFAULT 'main',
        agent_description TEXT,
        agent_tool_use_id TEXT,
        agent_type TEXT,
        spawn_depth INTEGER,
        model TEXT NOT NULL,
        stop_reason TEXT,
        tool_names TEXT NOT NULL DEFAULT '[]',
        content_kinds TEXT NOT NULL DEFAULT '[]',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_5m_tokens INTEGER,
        cache_creation_1h_tokens INTEGER,
        cache_creation_unclassified_tokens INTEGER NOT NULL DEFAULT 0,
        web_search_requests INTEGER NOT NULL DEFAULT 0,
        web_fetch_requests INTEGER NOT NULL DEFAULT 0,
        code_execution_requests INTEGER NOT NULL DEFAULT 0,
        service_tier TEXT,
        speed TEXT,
        inference_geo TEXT,
        iterations_json TEXT,
        event_kind TEXT NOT NULL DEFAULT 'usage',
        error_code TEXT,
        error_status INTEGER,
        status_text TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_records_time
        ON usage_records(ended_at, id);
      CREATE INDEX IF NOT EXISTS idx_usage_records_session
        ON usage_records(session_id, ended_at);
      CREATE INDEX IF NOT EXISTS idx_usage_records_prompt
        ON usage_records(prompt_uuid);
      CREATE INDEX IF NOT EXISTS idx_usage_windows_start
        ON usage_windows(start_at);
      CREATE INDEX IF NOT EXISTS idx_prompt_ancestry_updated
        ON prompt_ancestry(updated_at);
      CREATE INDEX IF NOT EXISTS idx_prompt_ancestry_prompt
        ON prompt_ancestry(prompt_uuid);
    `);

    // Existing databases predate content_at. Keeping this migration beside the
    // schema makes opening either version idempotent.
    this._ensureColumn('transcript_cursors', 'content_at', 'INTEGER NOT NULL DEFAULT 0');
    this._ensureColumn('transcript_cursors', 'last_prompt_kind', 'TEXT');
    this._ensureColumn('prompt_ancestry', 'prompt_kind', 'TEXT');
    this._ensureColumn('usage_records', 'agent_description', 'TEXT');
    this._ensureColumn('usage_records', 'agent_tool_use_id', 'TEXT');
    this._ensureColumn('usage_records', 'git_branch', 'TEXT');
    this._ensureColumn('usage_records', 'event_kind', "TEXT NOT NULL DEFAULT 'usage'");
    this._ensureColumn('usage_records', 'error_code', 'TEXT');
    this._ensureColumn('usage_records', 'error_status', 'INTEGER');
    this._ensureColumn('usage_records', 'status_text', 'TEXT');
  }

  _ensureColumn(table, column, definition) {
    const columns = this.db.pragma(`table_info(${table})`);
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  _prepare() {
    this.hourAggregateStatements = new Map();
    this.existingRecordStatements = new Map();
    this.upsertPrompt = this.db.prepare(`
      INSERT INTO prompts(uuid, text, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
    `);
    this.promptLinkBatchStatements = new Map();
    this.upsertRecord = this.db.prepare(`
      INSERT INTO usage_records (
        id, session_id, request_id, message_id, first_uuid, last_uuid,
        source_path, first_line, last_line, started_at, ended_at, cwd,
        project_name, git_branch, prompt_text, prompt_uuid, agent_id, agent_label,
        agent_description, agent_tool_use_id, agent_type, spawn_depth, model,
        stop_reason, tool_names, content_kinds,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cache_creation_5m_tokens, cache_creation_1h_tokens,
        cache_creation_unclassified_tokens, web_search_requests,
        web_fetch_requests, code_execution_requests, service_tier, speed,
        inference_geo, iterations_json, event_kind, error_code, error_status,
        status_text, updated_at
      ) VALUES (
        @id, @sessionId, @requestId, @messageId, @firstUuid, @lastUuid,
        @sourcePath, @firstLine, @lastLine, @startedAt, @endedAt, @cwd,
        @projectName, @gitBranch, @promptText, @promptUuid, @agentId, @agentLabel,
        @agentDescription, @agentToolUseId, @agentType, @spawnDepth, @model,
        @stopReason, @toolNames, @contentKinds,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheCreationTokens,
        @cacheCreation5mTokens, @cacheCreation1hTokens,
        @cacheCreationUnclassifiedTokens, @webSearchRequests,
        @webFetchRequests, @codeExecutionRequests, @serviceTier, @speed,
        @inferenceGeo, @iterationsJson, @eventKind, @errorCode, @errorStatus,
        @statusText, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        request_id = COALESCE(excluded.request_id, usage_records.request_id),
        message_id = COALESCE(excluded.message_id, usage_records.message_id),
        last_uuid = excluded.last_uuid,
        source_path = excluded.source_path,
        first_line = MIN(usage_records.first_line, excluded.first_line),
        last_line = MAX(usage_records.last_line, excluded.last_line),
        started_at = MIN(usage_records.started_at, excluded.started_at),
        ended_at = MAX(usage_records.ended_at, excluded.ended_at),
        cwd = COALESCE(excluded.cwd, usage_records.cwd),
        project_name = COALESCE(excluded.project_name, usage_records.project_name),
        git_branch = COALESCE(excluded.git_branch, usage_records.git_branch),
        prompt_text = COALESCE(excluded.prompt_text, usage_records.prompt_text),
        prompt_uuid = COALESCE(excluded.prompt_uuid, usage_records.prompt_uuid),
        agent_id = COALESCE(excluded.agent_id, usage_records.agent_id),
        agent_label = excluded.agent_label,
        agent_description = COALESCE(excluded.agent_description, usage_records.agent_description),
        agent_tool_use_id = COALESCE(excluded.agent_tool_use_id, usage_records.agent_tool_use_id),
        agent_type = COALESCE(excluded.agent_type, usage_records.agent_type),
        spawn_depth = COALESCE(excluded.spawn_depth, usage_records.spawn_depth),
        model = excluded.model,
        stop_reason = COALESCE(excluded.stop_reason, usage_records.stop_reason),
        tool_names = excluded.tool_names,
        content_kinds = excluded.content_kinds,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        cache_creation_5m_tokens = excluded.cache_creation_5m_tokens,
        cache_creation_1h_tokens = excluded.cache_creation_1h_tokens,
        cache_creation_unclassified_tokens = excluded.cache_creation_unclassified_tokens,
        web_search_requests = excluded.web_search_requests,
        web_fetch_requests = excluded.web_fetch_requests,
        code_execution_requests = excluded.code_execution_requests,
        service_tier = excluded.service_tier,
        speed = excluded.speed,
        inference_geo = excluded.inference_geo,
        iterations_json = excluded.iterations_json,
        event_kind = excluded.event_kind,
        error_code = excluded.error_code,
        error_status = excluded.error_status,
        status_text = excluded.status_text,
        updated_at = excluded.updated_at
    `);
    this.upsertCursor = this.db.prepare(`
      INSERT INTO transcript_cursors (
        source_path, byte_offset, line_number, file_size, mtime_ms,
        session_id, cwd, last_prompt, last_prompt_uuid, last_prompt_kind,
        content_at, last_seen_at
      ) VALUES (
        @sourcePath, @byteOffset, @lineNumber, @fileSize, @mtimeMs,
        @sessionId, @cwd, @lastPrompt, @lastPromptUuid, @lastPromptKind,
        @contentAt, @lastSeenAt
      )
      ON CONFLICT(source_path) DO UPDATE SET
        byte_offset = excluded.byte_offset,
        line_number = excluded.line_number,
        file_size = excluded.file_size,
        mtime_ms = excluded.mtime_ms,
        session_id = excluded.session_id,
        cwd = excluded.cwd,
        last_prompt = excluded.last_prompt,
        last_prompt_uuid = excluded.last_prompt_uuid,
        last_prompt_kind = excluded.last_prompt_kind,
        content_at = excluded.content_at,
        last_seen_at = excluded.last_seen_at
    `);
    this.insertManyPromptLinks = this.db.transaction((links) => {
      let changes = 0;
      const savedPrompts = new Set();
      const normalizedLinks = [];
      for (const link of links) {
        if (!link.entryUuid || !link.promptUuid || !link.promptText) continue;
        const normalized = { ...link, promptKind: link.promptKind || 'human' };
        if (!savedPrompts.has(link.promptUuid)) {
          this.upsertPrompt.run(link.promptUuid, link.promptText, link.updatedAt);
          savedPrompts.add(link.promptUuid);
        }
        normalizedLinks.push(normalized);
      }
      // Crossing the JS/native boundary once per transcript entry dominates a
      // first import on large histories. Batch the normalized UUID links while
      // keeping the same conflict semantics and enclosing transaction.
      for (let from = 0; from < normalizedLinks.length; from += 200) {
        const batch = normalizedLinks.slice(from, from + 200);
        let statement = this.promptLinkBatchStatements.get(batch.length);
        if (!statement) {
          const values = Array.from({ length: batch.length }, () => '(?, ?, ?, ?, ?)')
            .join(', ');
          statement = this.db.prepare(`
            INSERT INTO prompt_ancestry(
              source_path, entry_uuid, prompt_uuid, prompt_kind, updated_at
            ) VALUES ${values}
            ON CONFLICT(source_path, entry_uuid) DO UPDATE SET
              prompt_uuid = excluded.prompt_uuid,
              prompt_kind = excluded.prompt_kind,
              updated_at = excluded.updated_at
          `);
          this.promptLinkBatchStatements.set(batch.length, statement);
        }
        const parameters = batch.flatMap((link) => [
          link.sourcePath,
          link.entryUuid,
          link.promptUuid,
          link.promptKind,
          link.updatedAt,
        ]);
        changes += statement.run(parameters).changes;
      }
      return changes;
    });
    this.insertMany = this.db.transaction((records) => {
      let changes = 0;
      const existing = new Map();
      for (let from = 0; from < records.length; from += 500) {
        const ids = records.slice(from, from + 500).map((record) => record.id);
        let statement = this.existingRecordStatements.get(ids.length);
        if (!statement) {
          statement = this.db.prepare(`
            SELECT id, tool_names, content_kinds FROM usage_records
            WHERE id IN (${ids.map(() => '?').join(', ')})
          `);
          this.existingRecordStatements.set(ids.length, statement);
        }
        for (const row of statement.all(ids)) existing.set(row.id, row);
      }
      for (const record of records) {
        if (record.promptUuid && record.promptText) {
          this.upsertPrompt.run(record.promptUuid, record.promptText, record.updatedAt);
          record.promptText = null;
        }
        const old = existing.get(record.id);
        record.toolNames = JSON.stringify(uniqueStrings(
          jsonArray(old?.tool_names), record.toolNames,
        ));
        record.contentKinds = JSON.stringify(uniqueStrings(
          jsonArray(old?.content_kinds), record.contentKinds,
        ));
        record.iterationsJson = record.iterations == null
          ? null
          : JSON.stringify(record.iterations);
        record.agentDescription ??= null;
        record.agentToolUseId ??= null;
        record.gitBranch ??= null;
        record.eventKind ??= 'usage';
        record.errorCode ??= null;
        record.errorStatus ??= null;
        record.statusText ??= null;
        delete record.iterations;
        changes += this.upsertRecord.run(record).changes;
      }
      return changes;
    });
  }

  getCursor(sourcePath) {
    return this.db.prepare(
      'SELECT * FROM transcript_cursors WHERE source_path = ?',
    ).get(sourcePath) || null;
  }

  saveCursor(cursor) {
    this.upsertCursor.run({
      ...cursor,
      lastPromptKind: cursor.lastPromptKind ?? null,
      contentAt: cursor.contentAt ?? 0,
    });
  }

  resetCursor(sourcePath) {
    return this.db.prepare(
      'DELETE FROM transcript_cursors WHERE source_path = ?',
    ).run(sourcePath).changes;
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO app_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value == null ? null : String(value));
  }

  getPromptForEntry(sourcePath, entryUuid) {
    if (!entryUuid) return null;
    const row = this.db.prepare(`
      SELECT prompts.uuid, prompts.text, prompt_ancestry.prompt_kind
      FROM prompt_ancestry
      JOIN prompts ON prompts.uuid = prompt_ancestry.prompt_uuid
      WHERE prompt_ancestry.source_path = ? AND prompt_ancestry.entry_uuid = ?
    `).get(sourcePath, entryUuid);
    return row ? { uuid: row.uuid, text: row.text, kind: row.prompt_kind || 'human' } : null;
  }

  insertPromptLinks(links) {
    return links.length ? this.insertManyPromptLinks(links) : 0;
  }

  clearSourceAncestry(sourcePath) {
    return this.db.prepare(
      'DELETE FROM prompt_ancestry WHERE source_path = ?',
    ).run(sourcePath).changes;
  }

  insertRecords(records) {
    if (!records.length) return 0;
    const changes = this.insertMany(records);
    if (changes) this.windowCache = null;
    return changes;
  }

  recordWindow(meter) {
    if (!meter || meter.kind !== 'session' || !Number.isFinite(meter.resetsAt)) return;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO usage_windows(reset_at, start_at, utilization, observed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(reset_at) DO UPDATE SET
        utilization = excluded.utilization,
        observed_at = excluded.observed_at
    `).run(meter.resetsAt, meter.resetsAt - WINDOW_MS, meter.utilization ?? null, now);
    this.windowCache = null;
  }

  _summarizeRange(window, cutoff = -Infinity) {
    const ranges = [];
    const firstHour = new Date(window.startAt);
    firstHour.setMinutes(0, 0, 0);
    for (let hourStart = firstHour.getTime(); hourStart < window.endAt; hourStart += HOUR_MS) {
      const startAt = Math.max(hourStart, window.startAt);
      const endAt = Math.min(hourStart + HOUR_MS, window.endAt);
      ranges.push({ startAt, endAt, queryStart: Math.max(startAt, cutoff) });
    }
    let statement = this.hourAggregateStatements.get(ranges.length);
    if (!statement) {
      const values = ranges.map(() => '(?, ?, ?, ?)').join(', ');
      statement = this.db.prepare(`
        WITH buckets(bucket_index, start_at, query_start, end_at) AS (
          VALUES ${values}
        )
        SELECT buckets.bucket_index, buckets.start_at, buckets.end_at,
          COUNT(usage_records.id) AS record_count,
          COALESCE(SUM(${totalSql}), 0) AS total_tokens,
          COUNT(DISTINCT CASE WHEN usage_records.id IS NOT NULL
            THEN CAST(usage_records.ended_at / 300000 AS INTEGER) END) * 5 AS active_minutes
        FROM buckets
        LEFT JOIN usage_records
          ON usage_records.ended_at >= buckets.query_start
          AND usage_records.ended_at < buckets.end_at
        GROUP BY buckets.bucket_index, buckets.start_at, buckets.end_at
        ORDER BY buckets.bucket_index
      `);
      this.hourAggregateStatements.set(ranges.length, statement);
    }
    const parameters = ranges.flatMap((range, index) => [
      index, range.startAt, range.queryStart, range.endAt,
    ]);
    const hours = statement.all(parameters).map((row) => ({
      startAt: row.start_at,
      endAt: row.end_at,
      recordCount: row.record_count,
      totalTokens: row.total_tokens,
      activeMinutes: row.active_minutes,
    }));
    return {
      ...window,
      hours,
      recordCount: hours.reduce((sum, hour) => sum + hour.recordCount, 0),
      totalTokens: hours.reduce((sum, hour) => sum + hour.totalTokens, 0),
      activeMinutes: hours.reduce((sum, hour) => sum + hour.activeMinutes, 0),
    };
  }

  listWindows(currentMeter = null) {
    const retention = this.getRetention();
    const dataVersion = this.db.pragma('data_version', { simple: true });
    const cacheKey = [
      dataVersion,
      retention.days,
      currentMeter?.kind || '',
      currentMeter?.resetsAt || 0,
      currentMeter?.utilization ?? '',
    ].join(':');
    if (this.windowCache?.key === cacheKey) return this.windowCache.value;
    const cutoff = Date.now() - retention.days * DAY_MS;
    const stored = this.db.prepare(
      `SELECT reset_at, start_at, utilization, observed_at
       FROM usage_windows WHERE reset_at > ? ORDER BY reset_at DESC`,
    ).all(cutoff);
    const candidates = new Map(stored.map((row) => [row.reset_at, {
      startAt: row.start_at,
      endAt: row.reset_at,
      utilization: row.utilization,
      observedAt: row.observed_at,
      current: false,
      inferred: false,
      kind: 'observed',
    }]));
    if (currentMeter?.kind === 'session' && Number.isFinite(currentMeter.resetsAt)) {
      candidates.set(currentMeter.resetsAt, {
        startAt: currentMeter.resetsAt - WINDOW_MS,
        endAt: currentMeter.resetsAt,
        utilization: currentMeter.utilization ?? null,
        observedAt: Date.now(),
        current: true,
        inferred: false,
        kind: 'observed',
      });
    }

    // Exact observations should normally be adjacent. If corrupt or historical
    // data overlaps, prefer current/newer observations and omit the conflicting
    // row so the same usage record can never be offered through two windows.
    const observed = [];
    const preferred = [...candidates.values()].sort((a, b) => (
      Number(b.current) - Number(a.current)
      || b.observedAt - a.observedAt
      || b.endAt - a.endAt
    ));
    for (const candidate of preferred) {
      const overlaps = observed.some((other) => (
        candidate.startAt < other.endAt && other.startAt < candidate.endAt
      ));
      if (!overlaps) observed.push(candidate);
    }
    observed.sort((a, b) => a.startAt - b.startAt);

    const recordSpan = this.db.prepare(`
      SELECT MIN(ended_at) AS min_at, MAX(ended_at) AS max_at
      FROM usage_records WHERE ended_at >= ? AND ended_at <= ?
    `).get(cutoff, Date.now() + DAY_MS);
    const unclassified = [];
    if (recordSpan.min_at != null && recordSpan.max_at != null) {
      const spanStart = Math.max(cutoff, recordSpan.min_at);
      const spanEnd = recordSpan.max_at + 1;
      const gaps = [];
      let cursor = spanStart;
      for (const window of observed) {
        if (window.endAt <= cursor || window.startAt >= spanEnd) continue;
        if (window.startAt > cursor) gaps.push([cursor, Math.min(window.startAt, spanEnd)]);
        cursor = Math.max(cursor, window.endAt);
        if (cursor >= spanEnd) break;
      }
      if (cursor < spanEnd) gaps.push([cursor, spanEnd]);

      for (const [gapStart, gapEnd] of gaps) {
        let startAt = gapStart;
        while (startAt < gapEnd) {
          const nextDay = new Date(startAt);
          nextDay.setHours(24, 0, 0, 0);
          const endAt = Math.min(gapEnd, nextDay.getTime());
          const summary = this._summarizeRange({
            startAt,
            endAt,
            utilization: null,
            observedAt: null,
            current: false,
            inferred: false,
            kind: 'unclassified',
          }, cutoff);
          if (summary.recordCount > 0) unclassified.push(summary);
          startAt = endAt;
        }
      }
    }

    const windows = [
      ...observed.map((window) => this._summarizeRange(window, cutoff)),
      ...unclassified,
    ].sort((a, b) => b.endAt - a.endAt || b.startAt - a.startAt);
    this.windowCache = { key: cacheKey, value: windows };
    return windows;
  }

  /**
   * Série DIÁRIA para o dashboard (fonte Local): agrega usage_records por dia
   * no fuso local do computador (Mac ou Windows — date() com 'localtime'),
   * separada por modelo para o pricing aplicar o preço certo. "Turno" =
   * requisição distinta (request_id; registros sem request contam pelo id).
   */
  summarizeDaily(days = 30) {
    const safeDays = Math.min(Math.max(Number(days) || 30, 1), 365);
    const cutoff = Date.now() - safeDays * DAY_MS;
    return this.db.prepare(`
      SELECT date(ended_at / 1000, 'unixepoch', 'localtime') AS day,
        model,
        COUNT(DISTINCT COALESCE(request_id, id)) AS turns,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
      FROM usage_records
      WHERE event_kind = 'usage' AND ended_at >= ?
      GROUP BY day, model
      ORDER BY day ASC
    `).all(cutoff);
  }

  listRecords({ startAt, endAt, cursor = null, limit = 500 }) {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const cursorTime = Number.isFinite(cursor?.endedAt) ? cursor.endedAt : null;
    const cursorId = typeof cursor?.id === 'string' ? cursor.id : null;
    const rows = this.db.prepare(`
      SELECT usage_records.*, COALESCE(prompts.text, usage_records.prompt_text) AS resolved_prompt,
        (${totalSql}) AS total_tokens
      FROM usage_records
      LEFT JOIN prompts ON prompts.uuid = usage_records.prompt_uuid
      WHERE ended_at >= @startAt AND ended_at < @endAt
        AND (@cursorTime IS NULL OR ended_at < @cursorTime
          OR (ended_at = @cursorTime AND usage_records.id < @cursorId))
      ORDER BY ended_at DESC, usage_records.id DESC
      LIMIT @rowLimit
    `).all({
      startAt: Math.max(startAt, Date.now() - this.getRetention().days * DAY_MS),
      endAt,
      cursorTime,
      cursorId,
      rowLimit: safeLimit + 1,
    });
    const hasMore = rows.length > safeLimit;
    if (hasMore) rows.pop();
    const last = rows[rows.length - 1];

    return {
      records: rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        requestId: row.request_id,
        messageId: row.message_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        projectName: row.project_name,
        gitBranch: row.git_branch,
        cwd: row.cwd,
        promptText: row.resolved_prompt,
        promptUuid: row.prompt_uuid,
        agentId: row.agent_id,
        agentLabel: row.agent_label,
        agentDescription: row.agent_description,
        agentToolUseId: row.agent_tool_use_id,
        agentType: row.agent_type,
        spawnDepth: row.spawn_depth,
        model: row.model,
        stopReason: row.stop_reason,
        toolNames: jsonArray(row.tool_names),
        contentKinds: jsonArray(row.content_kinds),
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        cacheCreation5mTokens: row.cache_creation_5m_tokens,
        cacheCreation1hTokens: row.cache_creation_1h_tokens,
        cacheCreationUnclassifiedTokens: row.cache_creation_unclassified_tokens,
        webSearchRequests: row.web_search_requests,
        webFetchRequests: row.web_fetch_requests,
        codeExecutionRequests: row.code_execution_requests,
        serviceTier: row.service_tier,
        speed: row.speed,
        inferenceGeo: row.inference_geo,
        iterations: jsonValue(row.iterations_json),
        eventKind: row.event_kind,
        errorCode: row.error_code,
        errorStatus: row.error_status,
        statusText: row.status_text,
        totalTokens: row.total_tokens,
      })),
      nextCursor: hasMore && last ? { endedAt: last.ended_at, id: last.id } : null,
    };
  }

  databaseSize() {
    return [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]
      .reduce((total, file) => {
        try { return total + fs.statSync(file).size; } catch { return total; }
      }, 0);
  }

  _cleanupOrphanPrompts() {
    return this.db.prepare(`
      DELETE FROM prompts
      WHERE NOT EXISTS (
        SELECT 1 FROM usage_records WHERE usage_records.prompt_uuid = prompts.uuid
      ) AND NOT EXISTS (
        SELECT 1 FROM prompt_ancestry WHERE prompt_ancestry.prompt_uuid = prompts.uuid
      )
    `).run().changes;
  }

  _cleanupDetachedAncestry() {
    return this.db.prepare(`
      DELETE FROM prompt_ancestry
      WHERE NOT EXISTS (
        SELECT 1 FROM usage_records
        WHERE usage_records.prompt_uuid = prompt_ancestry.prompt_uuid
      )
    `).run().changes;
  }

  _compact() {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.pragma('incremental_vacuum(20000)');
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  _checkpoint() {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  prune(force = false) {
    this.windowCache = null;
    const now = Date.now();
    const retention = this.getRetention();
    // Maintenance is normally daily; settings changes pass force=true.
    const lastRun = Number(this.db.prepare(
      "SELECT value FROM app_meta WHERE key = 'last_prune'",
    ).get()?.value || 0);
    const cutoff = now - retention.days * DAY_MS;
    let deleted = 0;
    const runAgePrune = force || now - lastRun >= DAY_MS;
    if (runAgePrune) {
      const ageDelete = this.db.transaction(() => {
        deleted += this.db.prepare('DELETE FROM usage_records WHERE ended_at < ?').run(cutoff).changes;
        deleted += this.db.prepare('DELETE FROM usage_records WHERE ended_at > ?')
          .run(now + DAY_MS).changes;
        this.db.prepare('DELETE FROM usage_windows WHERE reset_at < ?').run(cutoff).changes;
        this.db.prepare('DELETE FROM prompt_ancestry WHERE updated_at < ?').run(cutoff);
        this.db.prepare('DELETE FROM transcript_cursors WHERE last_seen_at < ?').run(cutoff).changes;
        // An unchanged transcript is still seen every scan, so last_seen_at alone
        // cannot expire its sensitive context. Keep only the byte cursor needed
        // to avoid rereading the file and scrub the old session/prompt metadata.
        this.db.prepare(`
          UPDATE transcript_cursors SET
            session_id = NULL,
            cwd = NULL,
            last_prompt = NULL,
            last_prompt_uuid = NULL,
            last_prompt_kind = NULL
          WHERE content_at < ?
        `).run(cutoff);
        this._cleanupOrphanPrompts();
        this.db.prepare(`
          INSERT INTO app_meta(key, value) VALUES ('last_prune', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(now));
      });
      ageDelete();
    }

    const ceiling = retention.maxMb * 1024 * 1024;
    const target = Math.floor(ceiling * 0.9);
    if (!runAgePrune && this.databaseSize() <= ceiling) {
      return {
        deleted,
        sizeBytes: this.databaseSize(),
        overLimit: false,
        ageSkipped: true,
      };
    }
    // Stabilize the measurement without vacuuming the same pages both before
    // and after an eviction batch during a large first import.
    this._checkpoint();
    if (this.databaseSize() <= ceiling) {
      return {
        deleted,
        sizeBytes: this.databaseSize(),
        overLimit: false,
        ageSkipped: !runAgePrune,
      };
    }

    // Evict complete detail rows in chronological order until the database is
    // under the hysteresis target, or until only the minimal import cursors are
    // left. There is deliberately no arbitrary batch-count limit: a large first
    // import must not be allowed to remain permanently above the configured cap.
    while (this.databaseSize() > target) {
      let result = this.db.prepare(`
        DELETE FROM usage_records WHERE id IN (
          SELECT id FROM usage_records ORDER BY ended_at ASC, id ASC LIMIT 5000
        )
      `).run();
      if (result.changes) {
        deleted += result.changes;
        // Once a detail row is evicted, its otherwise unreachable prompt context
        // should not linger until the age cutoff.
        this._cleanupDetachedAncestry();
      } else {
        result = this.db.prepare(`
          DELETE FROM prompt_ancestry WHERE rowid IN (
            SELECT rowid FROM prompt_ancestry ORDER BY updated_at ASC LIMIT 5000
          )
        `).run();
        if (!result.changes) {
          result = this.db.prepare(`
            DELETE FROM usage_windows WHERE reset_at IN (
              SELECT reset_at FROM usage_windows ORDER BY reset_at ASC LIMIT 1000
            )
          `).run();
        }
        if (!result.changes) {
          result = this.db.prepare(`
            UPDATE transcript_cursors SET
              session_id = NULL,
              cwd = NULL,
              last_prompt = NULL,
              last_prompt_uuid = NULL,
              last_prompt_kind = NULL
            WHERE session_id IS NOT NULL OR cwd IS NOT NULL
              OR last_prompt IS NOT NULL OR last_prompt_uuid IS NOT NULL
              OR last_prompt_kind IS NOT NULL
          `).run();
        }
        if (!result.changes) break;
      }
      this._cleanupOrphanPrompts();
      this._compact();
    }

    const orphaned = this._cleanupOrphanPrompts();
    if (orphaned) this._compact();
    else this._checkpoint();
    if (this.databaseSize() > target) {
      // Incremental vacuum cannot reclaim an older database created without
      // auto_vacuum. A full vacuum is the final, rare compaction attempt.
      try {
        this.db.exec('VACUUM');
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Another short-lived reader may hold a lock; the next worker pass retries.
      }
    }
    const sizeBytes = this.databaseSize();
    return {
      deleted,
      sizeBytes,
      overLimit: sizeBytes > ceiling,
      ageSkipped: !runAgePrune,
    };
  }

  close() {
    if (!this.db?.open) return;
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    this.db.close();
  }
}

module.exports = { ConsumptionStore, WINDOW_MS, DAY_MS };
