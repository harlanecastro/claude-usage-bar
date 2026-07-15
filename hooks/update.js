#!/usr/bin/env node
/**
 * Maps a Claude Code hook event onto this session's state file:
 *   ~/.claude/statusbar/state.d/<session_id>.json
 *
 * Usage: node update.js <prompt|pre|post|notify|permreq|stop>
 *
 * Adapted from claude-status-bar's hooks/update.js, keeping the same file
 * contract so either project's reader is fed by either project's hooks.
 * Labels are looked up by locale here rather than being hardcoded in Portuguese.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = path.join(os.homedir(), '.claude', 'statusbar', 'state.d');
const event = process.argv[2] || '';

const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'unknown';

// The tool name is written to the file as-is; the widget translates it. Keeping
// the hook free of display strings means changing language needs no reinstall.
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => run());
process.stdin.on('error', () => run());
setTimeout(run, 1000); // hooks always pipe stdin, but must never hang the session

let done = false;

function run() {
  if (done) return;
  done = true;

  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch { /* no payload */ }

  const sid = safeId(p.session_id);
  const statePath = path.join(stateDir, sid + '.json');

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first event */ }

  const ts = Math.floor(Date.now() / 1000);
  let state = 'idle';
  let startedAt = prev.startedAt || 0;

  switch (event) {
    case 'prompt':
      state = 'thinking';
      startedAt = ts;
      break;
    case 'pre':
      state = 'tool';
      if (!startedAt) startedAt = ts;
      break;
    case 'post':
      state = 'thinking';
      if (!startedAt) startedAt = ts;
      break;
    case 'notify': {
      // Only a permission prompt should drive the icon on the CLI path. Every
      // other Notification — especially the idle "Claude is waiting for your
      // input" — is ignored, so the icon rests instead of parking on a
      // confusing "waiting for you".
      const m = (p.message || '').toLowerCase();
      const isPerm = p.notification_type === 'permission_prompt'
        || m.includes('permission') || m.includes('approve') || m.includes('allow');
      if (!isPerm) return process.exit(0);
      state = 'permission';
      startedAt = 0;
      break;
    }
    case 'permreq':
      // The desktop app's permission signal; notify is CLI-only, so both exist.
      state = 'permission';
      startedAt = 0;
      break;
    case 'stop':
      state = 'done';
      startedAt = 0;
      break;
    default:
      return process.exit(0);
  }

  const out = {
    state,
    label: '',
    tool: p.tool_name || '',
    project: p.cwd ? path.basename(p.cwd) : prev.project || '',
    sessionId: p.session_id || '',
    transcript: p.transcript_path || prev.transcript || '',
    // process.ppid IS this session's `claude` process — hooks are spawned
    // directly by it and it is stable for the session's life. The reader uses it
    // as a liveness probe, which is what recovers from a force-quit.
    pid: process.ppid,
    startedAt,
    ts,
  };

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = statePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, statePath); // atomic: the reader never sees half a file
  } catch { /* nothing useful to do from a hook */ }

  process.exit(0);
}
