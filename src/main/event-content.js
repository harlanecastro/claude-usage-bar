'use strict';

/**
 * Conteúdo REAL de um evento (o que foi enviado e recebido da API), lido sob
 * demanda do transcript — o ingest guarda só contagem de tokens e metadados, não
 * o conteúdo. Localiza a entrada `assistant` do registro (por uuid) para o OUTPUT
 * (texto/raciocínio + a chamada de ferramenta com o input real) e a entrada `user`
 * anterior (parentUuid) para o INPUT que ENTROU no turno (texto / tool_result). O
 * restante do input da chamada é o contexto acumulado, que vem do cache — por isso
 * "Enviado" mostra o que é novo no turno (o que de fato gera tokens de escrita).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024 * 1024; // trava de segurança contra transcript gigante
const MAX_BLOCK_CHARS = 8000;
const MAX_BLOCKS = 40;
const CODEX_TOOL_CALL_TYPES = new Set([
  'function_call', 'custom_tool_call', 'tool_search_call',
]);
const CODEX_TOOL_OUTPUT_TYPES = new Set([
  'function_call_output', 'custom_tool_call_output', 'tool_search_output',
]);

function transcriptRoots(origin) {
  if (origin === 'codex') {
    const codexRoot = process.env.CODEX_HOME
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), '.codex');
    return [
      path.join(codexRoot, 'sessions'),
      path.join(codexRoot, 'archived_sessions'),
    ];
  }
  return [path.join(os.homedir(), '.claude', 'projects')];
}

// Só lê .jsonl DENTRO das raízes conhecidas — nunca um caminho arbitrário.
function underRoot(sourcePath, origin) {
  const resolved = path.resolve(String(sourcePath || ''));
  return resolved.endsWith('.jsonl') && transcriptRoots(origin)
    .some((root) => resolved.startsWith(path.resolve(root) + path.sep));
}

function truncate(value) {
  const str = String(value ?? '');
  return str.length <= MAX_BLOCK_CHARS
    ? { text: str, truncated: false }
    : { text: str.slice(0, MAX_BLOCK_CHARS), truncated: true };
}

function stringify(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : stringify(block)))
      .join('\n');
  }
  return stringify(content);
}

function outputBlocks(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || blocks.length >= MAX_BLOCKS) break;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ kind: 'text', ...truncate(block.text) });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      blocks.push({ kind: 'thinking', ...truncate(block.thinking) });
    } else if (block.type === 'tool_use') {
      blocks.push({ kind: 'tool_use', name: block.name || 'tool', ...truncate(stringify(block.input)) });
    }
  }
  return blocks;
}

function inputBlocks(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return [{ kind: 'text', ...truncate(content) }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || blocks.length >= MAX_BLOCKS) break;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ kind: 'text', ...truncate(block.text) });
    } else if (block.type === 'tool_result') {
      blocks.push({ kind: 'tool_result', ...truncate(toolResultText(block.content)) });
    }
  }
  return blocks;
}

function codexMessageBlocks(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content
    .filter((block) => (
      (block?.type === 'input_text' || block?.type === 'output_text')
      && typeof block.text === 'string'
    ))
    .slice(0, MAX_BLOCKS)
    .map((block) => ({ kind: 'text', ...truncate(block.text) }));
}

function appendUnique(list, block) {
  if (!block || list.length >= MAX_BLOCKS) return;
  const key = `${block.kind}\0${block.name || ''}\0${block.text}`;
  if (!list.some((item) => `${item.kind}\0${item.name || ''}\0${item.text}` === key)) {
    list.push(block);
  }
}

function readCodexEventContent(raw, firstLine, lastLine) {
  const lines = raw.split('\n');
  const start = Math.max(0, Number(firstLine) - 1);
  const end = Math.min(lines.length, Math.max(start + 1, Number(lastLine) || lines.length));
  const input = [];
  const output = [];
  let seenOutput = false;
  for (const line of lines.slice(start, end)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload || {};
    if (entry.type === 'response_item' && payload.type === 'message') {
      if (payload.role === 'user' && !seenOutput) {
        codexMessageBlocks(payload).forEach((block) => appendUnique(input, block));
      } else if (payload.role === 'assistant') {
        seenOutput = true;
        codexMessageBlocks(payload).forEach((block) => appendUnique(output, block));
      }
    } else if (entry.type === 'response_item' && payload.type === 'agent_message') {
      if (!seenOutput) {
        codexMessageBlocks(payload).forEach((block) => appendUnique(input, block));
      }
    } else if (entry.type === 'response_item' && CODEX_TOOL_OUTPUT_TYPES.has(payload.type)) {
      if (!seenOutput) {
        appendUnique(input, {
          kind: 'tool_result',
          ...truncate(stringify(payload.output ?? payload.tools)),
        });
      }
    } else if (entry.type === 'response_item' && CODEX_TOOL_CALL_TYPES.has(payload.type)) {
      seenOutput = true;
      appendUnique(output, {
        kind: 'tool_use',
        name: payload.type === 'tool_search_call' ? 'tool_search' : (payload.name || 'tool'),
        ...truncate(stringify(payload.arguments ?? payload.input)),
      });
    } else if (entry.type === 'response_item' && payload.type === 'reasoning') {
      seenOutput = true;
      const summaries = Array.isArray(payload.summary) ? payload.summary : [];
      for (const summary of summaries) {
        if (summary?.type === 'summary_text' && typeof summary.text === 'string') {
          appendUnique(output, { kind: 'thinking', ...truncate(summary.text) });
        }
      }
    } else if (entry.type === 'event_msg' && payload.type === 'user_message' && !seenOutput) {
      appendUnique(input, { kind: 'text', ...truncate(payload.message) });
    } else if (entry.type === 'event_msg' && payload.type === 'agent_message') {
      seenOutput = true;
      appendUnique(output, { kind: 'text', ...truncate(payload.message) });
    } else if (entry.type === 'event_msg' && payload.type === 'agent_reasoning') {
      seenOutput = true;
      appendUnique(output, { kind: 'thinking', ...truncate(payload.text) });
    }
  }
  return { input, output };
}

function readEventContent({
  origin = 'claude_code', sourcePath, firstUuid, lastUuid, firstLine, lastLine,
}) {
  if (!underRoot(sourcePath, origin)) return { error: 'forbidden_path' };
  let raw;
  try {
    if (fs.statSync(sourcePath).size > MAX_FILE_BYTES) return { error: 'too_large' };
    raw = fs.readFileSync(sourcePath, 'utf8');
  } catch { return { error: 'read_failed' }; }

  if (origin === 'codex') {
    return readCodexEventContent(raw, firstLine, lastLine);
  }

  const entries = [];
  const byUuid = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    entries.push(entry);
    if (entry.uuid) byUuid.set(entry.uuid, entry);
  }

  const anchor = byUuid.get(lastUuid) || byUuid.get(firstUuid);
  if (!anchor || anchor.type !== 'assistant') return { error: 'not_found' };

  // OUTPUT: a resposta chega em várias linhas (thinking / text / tool_use) com o
  // MESMO message.id — junta as parcelas assistant desse id, na ordem do arquivo.
  const messageId = anchor.message?.id;
  const chunks = messageId
    ? entries.filter((entry) => entry.type === 'assistant' && entry.message?.id === messageId)
    : [anchor];
  const output = [];
  for (const chunk of chunks) {
    for (const block of outputBlocks(chunk.message)) {
      if (output.length >= MAX_BLOCKS) break;
      output.push(block);
    }
  }

  // INPUT: sobe pelos parentUuid pulando as parcelas assistant (mesma resposta) até
  // a 1ª entrada `user` — é o que ENTROU no turno (tool_result ou o prompt humano).
  let input = [];
  let cursor = chunks[0] || anchor;
  for (let hops = 0; cursor && hops < 100; hops += 1) {
    const parent = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : null;
    if (!parent) break;
    if (parent.type === 'user' && !parent.isMeta) { input = inputBlocks(parent); break; }
    cursor = parent;
  }

  return { input, output };
}

module.exports = { readEventContent, readCodexEventContent };
