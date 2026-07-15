/**
 * DIAGNOSTIC — plain node. Run while the app is running.
 *
 * Fires a real OS-level click at the centre of the widget's painted area, so
 * "do clicks reach us" is answered by the same input path a finger uses.
 *
 * Run: node spike/click-widget.js [left|right]
 */
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const HWND = 'uintptr_t';

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HWND, [HWND, HWND, 'str16', 'str16']);
const SetCursorPos = user32.func('__stdcall', 'SetCursorPos', 'bool', ['int', 'int']);
const mouse_event = user32.func('__stdcall', 'mouse_event', 'void', ['uint32', 'int', 'int', 'uint32', 'uintptr_t']);

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', [HWND, koffi.out(koffi.pointer(RECT))]);

const LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;

const button = process.argv[2] === 'right' ? 'right' : 'left';

const hTaskbar = FindWindowW('Shell_TrayWnd', null);
const hWidget = FindWindowExW(hTaskbar, 0, 'ClaudeUsageBarStrip', null);
if (!hWidget) {
  console.error('strip not found in the taskbar — is the app running?');
  process.exit(1);
}

const w = {};
GetWindowRect(hWidget, w);

const x = Math.round((w.left + w.right) / 2);
const y = Math.round((w.top + w.bottom) / 2);

console.log(`strip rect : ${w.left},${w.top} ${w.right - w.left}x${w.bottom - w.top}`);
console.log(`clicking ${button} at (${x},${y})`);

// Park the cursor elsewhere first: moving it to a spot it already occupies
// generates no WM_MOUSEMOVE, which makes a live window look dead.
SetCursorPos(400, 400);
setTimeout(() => SetCursorPos(x, y), 150);
setTimeout(() => {
  if (button === 'right') {
    mouse_event(RIGHTDOWN, 0, 0, 0, 0);
    mouse_event(RIGHTUP, 0, 0, 0, 0);
  } else {
    mouse_event(LEFTDOWN, 0, 0, 0, 0);
    mouse_event(LEFTUP, 0, 0, 0, 0);
  }
  console.log('sent. check the app log for "[diag] click received".');
}, 300);
