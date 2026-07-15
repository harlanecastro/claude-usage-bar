/**
 * DIAGNOSTIC — plain node.
 *
 * Enumerates every child of Shell_TrayWnd with its class, title, styles and
 * rect, so TrafficMonitor's embedded window (which demonstrably receives clicks)
 * can be diffed against ours (which does not). Run with both apps live.
 */
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const HWND = 'uintptr_t';

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const GetWindow = user32.func('__stdcall', 'GetWindow', HWND, [HWND, 'uint']);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', [HWND, koffi.out(koffi.pointer('uint16_t')), 'int']);
const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', [HWND, koffi.out(koffi.pointer('uint16_t')), 'int']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [HWND, 'int']);
const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', [HWND]);
const IsWindowEnabled = user32.func('__stdcall', 'IsWindowEnabled', 'bool', [HWND]);
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', [HWND, koffi.out(koffi.pointer('uint32'))]);

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', [HWND, koffi.out(koffi.pointer(RECT))]);

const GW_CHILD = 5, GW_HWNDNEXT = 2;
const GWL_STYLE = -16, GWL_EXSTYLE = -20;

const STYLES = [
  [0x40000000n, 'CHILD'], [0x80000000n, 'POPUP'], [0x10000000n, 'VISIBLE'],
  [0x08000000n, 'DISABLED'], [0x04000000n, 'CLIPSIBLINGS'], [0x02000000n, 'CLIPCHILDREN'],
  [0x00C00000n, 'CAPTION'], [0x00040000n, 'THICKFRAME'], [0x00800000n, 'BORDER'],
  [0x00080000n, 'SYSMENU'], [0x20000000n, 'MINIMIZE'],
];
const EXSTYLES = [
  [0x00000020n, 'TRANSPARENT'], [0x00080000n, 'LAYERED'], [0x08000000n, 'NOACTIVATE'],
  [0x00000080n, 'TOOLWINDOW'], [0x00040000n, 'APPWINDOW'], [0x00000008n, 'TOPMOST'],
  [0x00200000n, 'NOREDIRECTIONBITMAP'], [0x00000004n, 'NOPARENTNOTIFY'],
  [0x00100000n, 'COMPOSITED'], [0x00000200n, 'CONTROLPARENT'],
];

const decode = (bits, table) => table.filter(([b]) => bits & b).map(([, n]) => n).join('|') || '-';

const wstr = (fn, h) => {
  const buf = new Uint16Array(256);
  const n = fn(h, buf, 256);
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le');
};

const hTaskbar = FindWindowW('Shell_TrayWnd', null);
const tb = {};
GetWindowRect(hTaskbar, tb);
console.log(`Shell_TrayWnd  ${tb.left},${tb.top} ${tb.right - tb.left}x${tb.bottom - tb.top}\n`);

let h = GetWindow(hTaskbar, GW_CHILD);
let i = 0;
while (h && h.toString() !== '0' && i < 40) {
  const cls = wstr(GetClassNameW, h);
  const title = wstr(GetWindowTextW, h);
  const style = BigInt(GetWindowLongPtrW(h, GWL_STYLE));
  const ex = BigInt(GetWindowLongPtrW(h, GWL_EXSTYLE));
  const r = {};
  GetWindowRect(h, r);
  const pid = [0];
  GetWindowThreadProcessId(h, pid);

  console.log(`[${String(i).padStart(2)}] ${cls}${title ? `  "${title}"` : ''}`);
  console.log(`     pid=${pid[0]}  vis=${IsWindowVisible(h) ? 'Y' : 'n'}  enabled=${IsWindowEnabled(h) ? 'Y' : 'n'}`);
  console.log(`     rect=${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}`);
  console.log(`     style   = 0x${style.toString(16)}  ${decode(style, STYLES)}`);
  console.log(`     exstyle = 0x${ex.toString(16)}  ${decode(ex, EXSTYLES)}`);
  console.log('');

  h = GetWindow(h, GW_HWNDNEXT);
  i++;
}
