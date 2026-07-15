#!/usr/bin/env node
/**
 * SessionStart / SessionEnd hooks. Usage: node lifecycle.js <start|end>
 *
 * Adapted from claude-status-bar's hooks/lifecycle.js. The macOS-only parts are
 * gone: that project launches its menu bar app from this hook and quits it when
 * idle, whereas Claude Usage Bar is already running — it is the widget.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = path.join(os.homedir(), '.claude', 'statusbar', 'state.d');
const event = process.argv[2];

const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'unknown';

let input = '';
let done = false;
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => run());
process.stdin.on('error', () => run());
setTimeout(run, 1000);

function run() {
  if (done) return;
  done = true;

  let id = '';
  let cwd = '';
  try {
    const j = JSON.parse(input);
    id = j.session_id;
    cwd = j.cwd || '';
  } catch { /* no payload */ }

  const statePath = path.join(stateDir, safeId(id) + '.json');

  try {
    fs.mkdirSync(stateDir, { recursive: true });

    if (event === 'start') {
      // Seed an idle file. SessionStart also fires on resume with no turn
      // running, so this doubles as clearing any state frozen by the last exit.
      const tmp = statePath + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        state: 'idle',
        label: '',
        tool: '',
        project: cwd ? path.basename(cwd) : '',
        sessionId: safeId(id),
        transcript: '',
        pid: process.ppid,
        startedAt: 0,
        ts: Math.floor(Date.now() / 1000),
      }));
      fs.renameSync(tmp, statePath);
    } else if (event === 'end') {
      // Removing the file drops the session. This is also what recovers a frozen
      // animation on force-quit: SessionEnd fires even when Stop does not.
      fs.rmSync(statePath, { force: true });
    }
  } catch { /* nothing useful to do from a hook */ }

  process.exit(0);
}
