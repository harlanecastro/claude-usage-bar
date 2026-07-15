#!/usr/bin/env node
/**
 * Registers the status hooks in ~/.claude/settings.json and copies the scripts
 * to ~/.claude/statusbar/. Merges rather than clobbers, and is re-runnable: our
 * own hooks are stripped before being re-added.
 *
 * Adapted from claude-status-bar's hooks/install.js. If that project's hooks are
 * already installed, this one is unnecessary — both write the same files.
 *
 *   node hooks/install.js            install / refresh
 *   node hooks/install.js --remove   uninstall
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const sbDir = path.join(home, '.claude', 'statusbar');
const settingsPath = path.join(home, '.claude', 'settings.json');
const node = process.execPath;
const remove = process.argv.includes('--remove');

const updateDest = path.join(sbDir, 'usagebar-update.js');
const lifecycleDest = path.join(sbDir, 'usagebar-lifecycle.js');

// Every command we add points at one of our two scripts; that is how we find
// ours again to strip them without touching anyone else's hooks.
const MARKER = 'usagebar-';

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${settingsPath}: ${err.message}`);
    console.error('Fix or move that file and run this again — refusing to overwrite it.');
    process.exit(1);
  }
  const backup = settingsPath + '.bak-usagebar';
  if (!fs.existsSync(backup)) fs.copyFileSync(settingsPath, backup);
}

settings.hooks = settings.hooks || {};

const stripOurs = (entries) => (entries || [])
  .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((h) => !(h.command || '').includes(MARKER)) }))
  .filter((entry) => (entry.hooks || []).length > 0);

for (const event of Object.keys(settings.hooks)) {
  settings.hooks[event] = stripOurs(settings.hooks[event]);
  if (!settings.hooks[event].length) delete settings.hooks[event];
}

if (remove) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  fs.rmSync(updateDest, { force: true });
  fs.rmSync(lifecycleDest, { force: true });
  console.log('Removed the Claude Usage Bar status hooks from', settingsPath);
  process.exit(0);
}

fs.mkdirSync(sbDir, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'update.js'), updateDest);
fs.copyFileSync(path.join(__dirname, 'lifecycle.js'), lifecycleDest);

const quoted = (p) => (p.includes(' ') ? `"${p}"` : p);
const cmd = (script, arg) => `${quoted(node)} ${quoted(script)} ${arg}`;

const add = (event, command, matched) => {
  settings.hooks[event] = settings.hooks[event] || [];
  const entry = { hooks: [{ type: 'command', command }] };
  if (matched) entry.matcher = '*';
  settings.hooks[event].push(entry);
};

add('UserPromptSubmit', cmd(updateDest, 'prompt'));
add('PreToolUse', cmd(updateDest, 'pre'), true);
add('PostToolUse', cmd(updateDest, 'post'), true);
add('Notification', cmd(updateDest, 'notify'));
add('PermissionRequest', cmd(updateDest, 'permreq'), true);
add('Stop', cmd(updateDest, 'stop'));
add('SessionStart', cmd(lifecycleDest, 'start'));
add('SessionEnd', cmd(lifecycleDest, 'end'));

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log('Installed the status hooks into', settingsPath);
console.log('Scripts:', updateDest);
console.log('        ', lifecycleDest);
if (fs.existsSync(settingsPath + '.bak-usagebar')) {
  console.log('Backup (first run only):', settingsPath + '.bak-usagebar');
}
console.log('\nStart a new Claude Code session for the hooks to take effect.');
