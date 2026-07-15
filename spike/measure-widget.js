/**
 * DIAGNOSTIC — plain node. Run while the app is running.
 *
 * Prints the widget's real rect against the taskbar's, so "it looks misaligned"
 * becomes a number instead of an impression.
 */
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const HWND = 'uintptr_t';

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HWND, [HWND, HWND, 'str16', 'str16']);
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', [HWND, koffi.out(koffi.pointer(RECT))]);
const GetClientRect = user32.func('__stdcall', 'GetClientRect', 'bool', [HWND, koffi.out(koffi.pointer(RECT))]);

const r = (h) => { const o = {}; return GetWindowRect(h, o) ? o : null; };
const c = (h) => { const o = {}; return GetClientRect(h, o) ? o : null; };
const dims = (x) => (x ? `${x.left},${x.top} ${x.right - x.left}x${x.bottom - x.top}` : '?');

const hTaskbar = FindWindowW('Shell_TrayWnd', null);
const tb = r(hTaskbar);
console.log(`taskbar        : ${dims(tb)}`);

const hWidget = FindWindowExW(hTaskbar, 0, 'Chrome_WidgetWin_1', null);
if (!hWidget) {
  console.log('widget         : NOT FOUND as a child of Shell_TrayWnd — is the app running?');
  process.exit(1);
}

const w = r(hWidget);
console.log(`widget window  : ${dims(w)}`);
console.log(`widget client  : ${dims(c(hWidget))}`);

const hRender = FindWindowExW(hWidget, 0, 'Chrome_RenderWidgetHostHWND', null);
if (hRender) console.log(`render surface : ${dims(r(hRender))}`);

const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [HWND, 'int']);
const STYLES = [
  [0x40000000n, 'WS_CHILD'], [0x80000000n, 'WS_POPUP'], [0x10000000n, 'WS_VISIBLE'],
  [0x00C00000n, 'WS_CAPTION'], [0x00040000n, 'WS_THICKFRAME'], [0x00800000n, 'WS_BORDER'],
  [0x00400000n, 'WS_DLGFRAME'], [0x00080000n, 'WS_SYSMENU'], [0x02000000n, 'WS_CLIPCHILDREN'],
  [0x04000000n, 'WS_CLIPSIBLINGS'], [0x20000000n, 'WS_MINIMIZE'], [0x01000000n, 'WS_MAXIMIZEBOX'],
];
const style = BigInt(GetWindowLongPtrW(hWidget, -16));
console.log(`\nstyle 0x${style.toString(16)} = ${STYLES.filter(([b]) => style & b).map(([, n]) => n).join(' | ')}`);

console.log('');
console.log(`offset in bar  : x=${w.left - tb.left}  y=${w.top - tb.top}`);
console.log(`height         : widget=${w.bottom - w.top}  taskbar=${tb.bottom - tb.top}`);
console.log(`bottom gap     : ${tb.bottom - w.bottom}px`);
console.log('');
console.log(w.top === tb.top && w.bottom === tb.bottom
  ? 'VERDICT: widget spans the full taskbar height — any misalignment is CSS.'
  : 'VERDICT: widget rect does NOT match the taskbar height — geometry bug.');
