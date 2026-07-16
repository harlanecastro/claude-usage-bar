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
 * Signal 0 tests a process's existence without touching it. EPERM means it is
 * there but not ours, which counts as alive.
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

// How long a transcript can sit untouched before its session is presumed gone.
// Generous on purpose: a session parked on a permission prompt writes nothing
// while it waits for you, and that is exactly the session worth showing.
const STALE_TRANSCRIPT = 30 * 60 * 1000;

/**
 * Is this session still running?
 *
 * The pid alone is not enough, and trusting it cost this feature dearly: the
 * hook records process.ppid, which on macOS is the `claude` process itself, but
 * on Windows Claude Code runs hooks through a shell — so ppid is that shell,
 * already dead by the time anyone reads the file. Every session looked gone and
 * the widget stayed empty while Claude was plainly working.
 *
 * So the pid is treated as proof of life when it holds, and the transcript —
 * which a live session appends to as it works — decides when it does not.
 */
function isAlive(s) {
  if (s.pid && pidAlive(s.pid)) return true;
  if (s.transcript) {
    try {
      return Date.now() - fs.statSync(s.transcript).mtimeMs < STALE_TRANSCRIPT;
    } catch { /* transcript gone */ }
  }
  // Nothing to disprove it with: a file that exists at all means a hook wrote it.
  return !s.pid;
}

/** Tail of a possibly large transcript, newest line first. */
function tailLines(file, span = 16384) {
  try {
    const size = fs.statSync(file).size;
    const take = Math.min(size, span);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, size - take);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter((l) => l.trim()).reverse();
  } catch {
    return [];
  }
}

/**
 * Did this session's last turn end with the user hitting Esc?
 *
 * Escape and a denied permission fire no hook, so the state file freezes on
 * "thinking" forever; this is the net that catches it.
 *
 * It must parse rather than grep. The marker is a user turn whose text is
 * literally "[Request interrupted by user]", and searching the raw JSON for that
 * phrase matches the moment anyone so much as discusses it in the conversation —
 * this very transcript contains it fifteen times for that reason, which silently
 * hid every session.
 */
function lastTurnInterrupted(file) {
  for (const line of tailLines(file)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partial first line from the tail cut
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue; // not a turn

    if (entry.type === 'assistant') return false; // the last turn is Claude's; not an interrupt
    const content = entry.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map((c) => c?.text ?? '').join(' ') : '';
    return text.includes('[Request interrupted by user]');
  }
  return false;
}

/** The state to actually act on, once the recovery nets have had their say. */
function effectiveState(s, nowSec) {
  const { state } = s;
  if (state === 'thinking' || state === 'tool' || state === 'permission') {
    const cap = state === 'permission' ? CAP_PERMISSION : CAP_WORKING;
    if (nowSec - (s.ts || 0) > cap) return 'idle';
    if (s.transcript && lastTurnInterrupted(s.transcript)) return 'idle';
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
    .filter(isAlive)
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

/** Are the hooks installed at all? The install is what creates this directory. */
function hooksInstalled() {
  try {
    return fs.existsSync(STATE_DIR);
  } catch {
    return false;
  }
}

module.exports = { activeSessions, currentStatus, hooksInstalled, STATE_DIR };
