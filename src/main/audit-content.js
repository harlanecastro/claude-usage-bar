'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const cache = new Map();

function allowed(sourcePath, origin) {
  const resolved = path.resolve(String(sourcePath || ''));
  const roots = origin === 'codex'
    ? [process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex')]
    : [path.join(os.homedir(), '.claude', 'projects')];
  return resolved.endsWith('.jsonl') && roots.some((root) => resolved.startsWith(path.resolve(root) + path.sep));
}

function section(kind, label, direction, content, mediaType = 'application/x-ndjson') {
  const raw = String(content ?? '');
  const id = crypto.randomUUID();
  cache.set(id, raw);
  return {
    id,
    kind,
    label,
    direction,
    media_type: mediaType,
    bytes: Buffer.byteLength(raw),
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    exact: false,
  };
}

function lineRange(raw, firstLine, lastLine) {
  const lines = raw.split('\n');
  const start = Math.max(0, Number(firstLine || 1) - 1);
  const end = Math.min(lines.length, Math.max(start + 1, Number(lastLine) || lines.length));
  return lines.slice(start, end).join('\n');
}

function localAuditManifest(location) {
  if (!allowed(location.source_path, location.origin)) return { error: 'forbidden_path' };
  let raw;
  try { raw = fs.readFileSync(location.source_path, 'utf8'); } catch { return { error: 'read_failed' }; }
  const scoped = location.origin === 'codex'
    ? lineRange(raw, location.first_line, location.last_line)
    : raw.split('\n').filter((line) => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line);
        return entry.uuid === location.first_uuid || entry.uuid === location.last_uuid
          || entry.message?.id === location.message_id;
      } catch { return false; }
    }).join('\n');
  const sections = [
    section(
      location.origin === 'codex' ? 'raw_rollout' : 'raw_transcript',
      location.origin === 'codex' ? 'Rollout bruto observável' : 'Transcript bruto observável',
      'both',
      scoped || raw,
    ),
  ];
  return {
    version: 1,
    audit_level: scoped ? 'cli_observable' : 'partial',
    provider: location.origin,
    sections,
    rounds: [{ index: 0, section_ids: sections.map((item) => item.id) }],
    limitations: [
      {
        code: 'cli_internal_unobservable',
        message: 'O CLI não expõe o corpo HTTP nem todas as instruções e schemas internos; esta auditoria contém integralmente apenas o rollout/transcript observável.',
      },
    ],
  };
}

function localAuditSection(sectionId) {
  if (!/^[0-9a-f-]{16,80}$/i.test(String(sectionId || '')) || !cache.has(sectionId)) {
    return { error: 'not_found' };
  }
  return { id: sectionId, encoding: 'utf8', content: cache.get(sectionId) };
}

module.exports = { localAuditManifest, localAuditSection };
