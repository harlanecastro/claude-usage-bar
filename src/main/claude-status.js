/**
 * What Claude Code is doing right now.
 *
 * Ported from claude-status-bar (Sources/main.swift), and deliberately sharing
 * its on-disk contract: Claude Code hooks write one JSON file per session to
 * ~/.claude/statusbar/state.d/<session_id>.json, and this reads them. Same
 * files, same shape — install either project's hooks and both are fed.
 *
 *   { state, label, tool, project, sessionId, transcript, pid, startedAt, ts }
 *
 * state: idle | thinking | tool | permission | done
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'statusbar', 'state.d');

// A frozen file is the failure mode here: Esc, or a denied permission, fires no
// hook, so the last state would spin forever. Two nets catch that — an absolute
// age cap, and the transcript's "interrupted by user" marker.
const CAP_PERMISSION = 7200; // seconds
const CAP_WORKING = 900;

const PRIORITY = { permission: 2, thinking: 1, tool: 1 };

function readSessions() {
  let names = [];
  try {
    names = fs.readdirSync(STATE_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return []; // hooks not installed, or nothing has run yet
  }

  const out = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(STATE_DIR, name), 'utf8');
      const s = JSON.parse(raw);
      if (s && typeof s.state === 'string') out.push(s);
    } catch { /* mid-write or malformed; it will be there next tick */ }
  }
  return out;
}

/**
 * Is this session's `claude` process still alive? Signal 0 tests existence
 * without touching the process. EPERM means it exists but is not ours — which
 * should not happen for a same-user session, but counts as alive either way.
 */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Last non-empty line of a possibly large transcript, read from the tail. */
function lastLine(file) {
  try {
    const size = fs.statSync(file).size;
    const span = Math.min(size, 8192);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    return lines.length ? lines[lines.length - 1] : '';
  } catch {
    return '';
  }
}

/** The state to actually act on, once the recovery nets have had their say. */
function effectiveState(s, nowSec) {
  const { state } = s;
  if (state === 'thinking' || state === 'tool' || state === 'permission') {
    const cap = state === 'permission' ? CAP_PERMISSION : CAP_WORKING;
    if (nowSec - (s.ts || 0) > cap) return 'idle';
    if (s.transcript && lastLine(s.transcript).includes('interrupted by user')) return 'idle';
    return state;
  }
  return state === 'done' ? 'idle' : state;
}

/**
 * Every session worth showing, most important first.
 *
 * Highest priority wins, ties broken by recency — so a session waiting on YOU is
 * never buried behind one that is merely thinking. The order is stable for a
 * given set of states, which is what makes cycling through them predictable.
 *
 * @returns {Array<{id,state,label,tool,project,startedAt}>} empty when nothing is active.
 */
function activeSessions() {
  const nowSec = Math.floor(Date.now() / 1000);

  const live = readSessions()
    .filter((s) => (s.pid ? pidAlive(s.pid) : true))
    .map((s) => ({ ...s, eff: effectiveState(s, nowSec) }))
    .filter((s) => PRIORITY[s.eff]);

  live.sort((a, b) => {
    const pa = PRIORITY[a.eff] ?? 0;
    const pb = PRIORITY[b.eff] ?? 0;
    return pa === pb ? (b.ts || 0) - (a.ts || 0) : pb - pa;
  });

  return live.map((s) => ({
    id: s.sessionId || '',
    state: s.eff,
    label: s.label || '',
    tool: s.tool || '',
    project: s.project || '',
    // Cleared for permission: there is no turn running to time.
    startedAt: s.eff === 'permission' ? 0 : (s.startedAt || 0),
  }));
}

/** The one session that matters most, or null when nothing is active. */
function currentStatus() {
  return activeSessions()[0] ?? null;
}

/** Are the hooks installed and writing? Drives the "set this up" hint. */
function hooksInstalled() {
  try {
    return fs.existsSync(STATE_DIR);
  } catch {
    return false;
  }
}

module.exports = { activeSessions, currentStatus, hooksInstalled, STATE_DIR };
