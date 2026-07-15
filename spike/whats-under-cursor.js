/**
 * DIAGNOSTIC — plain node, no Electron.
 *
 * Asks Windows itself which HWND is under the cursor. If our widget never shows
 * up here while the mouse is over it, the problem is hit-testing at the OS
 * level, not anything in our renderer.
 *
 * Run: node spike/whats-under-cursor.js   (then hover the widget)
 */
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const HWND = 'uintptr_t';

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const GetCursorPos = user32.func('__stdcall', 'GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))]);
const WindowFromPoint = user32.func('__stdcall', 'WindowFromPoint', HWND, [POINT]);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', [HWND, koffi.out(koffi.pointer('uint16_t')), 'int']);
const GetParent = user32.func('__stdcall', 'GetParent', HWND, [HWND]);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [HWND, 'int']);

const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20n;
const WS_EX_LAYERED = 0x80000n;
const WS_EX_NOACTIVATE = 0x8000000n;

const className = (h) => {
  if (!h || h.toString() === '0') return '(null)';
  const buf = new Uint16Array(256);
  const n = GetClassNameW(h, buf, 256);
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le');
};

const exOf = (h) => {
  const ex = BigInt(GetWindowLongPtrW(h, GWL_EXSTYLE));
  const flags = [];
  if (ex & WS_EX_TRANSPARENT) flags.push('TRANSPARENT');
  if (ex & WS_EX_LAYERED) flags.push('LAYERED');
  if (ex & WS_EX_NOACTIVATE) flags.push('NOACTIVATE');
  return flags.join('|') || '-';
};

let last = '';
console.log('Hover the widget. Ctrl+C to stop.\n');

setInterval(() => {
  const p = {};
  if (!GetCursorPos(p)) return;
  if (p.y < 1000) return; // only care about the taskbar strip

  const h = WindowFromPoint(p);
  const chain = [];
  let cur = h;
  for (let i = 0; i < 4 && cur && cur.toString() !== '0'; i++) {
    chain.push(`${className(cur)}[${exOf(cur)}]`);
    cur = GetParent(cur);
  }

  const line = `(${p.x},${p.y}) -> ${chain.join('  <-  ')}`;
  if (line !== last) {
    console.log(line);
    last = line;
  }
}, 250);
