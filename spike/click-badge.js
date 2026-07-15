/**
 * DIAGNOSTIC — clicks the session-count badge.
 *
 * Posts WM_LBUTTONUP straight to the strip: synthetic mouse input (mouse_event /
 * SendInput) does not get delivered over the taskbar, so this is the only way to
 * exercise the click path without a human.
 *
 * The badge sits inline after the label, so it moves whenever the label's width
 * changes — the rect has to be read fresh, not remembered.
 *
 * Run the app with --verbose so it prints its hit regions, then: node spike/click-badge.js <logfile>
 */
const fs = require('fs');
const koffi = require('koffi');

const u = koffi.load('user32.dll');
const H = 'uintptr_t';
const FindWindowW = u.func('__stdcall', 'FindWindowW', H, ['str16', 'str16']);
const FindWindowExW = u.func('__stdcall', 'FindWindowExW', H, [H, H, 'str16', 'str16']);
const PostMessageW = u.func('__stdcall', 'PostMessageW', 'bool', [H, 'uint', 'uintptr_t', 'intptr_t']);

const log = fs.readFileSync(process.argv[2] || '/tmp/hits2.log', 'utf8');
const lines = [...log.matchAll(/hit regions: (\[.*\])/g)];
if (!lines.length) { console.error('no hit regions in the log — is it running with --verbose?'); process.exit(1); }

const hits = JSON.parse(lines[lines.length - 1][1]);
const badge = hits.find((h) => h.action === 'cycle');
if (!badge) { console.error('no cycle badge on screen'); process.exit(1); }

const strip = FindWindowExW(FindWindowW('Shell_TrayWnd', null), 0, 'ClaudeUsageBarStrip', null);
if (!strip) { console.error('strip not found'); process.exit(1); }

const x = badge.x + Math.floor(badge.width / 2);
const y = badge.y + Math.floor(badge.height / 2);
PostMessageW(strip, 0x0202, 0, BigInt((y << 16) | (x & 0xFFFF)));
console.log(`clicked the badge at ${x},${y}`);
