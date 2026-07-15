/**
 * SPIKE 2 — why didn't spike 1 render?
 *
 * Spike 1 proved SetParent succeeds (GetParent == Shell_TrayWnd) but nothing
 * drew. Two candidate explanations:
 *   (a) our child HWND is underneath the Win11 XAML/DirectComposition surface
 *   (b) Chromium isn't painting into a reparented window at all
 *
 * This walks the taskbar's real child z-order and reports our window's
 * visibility/rect/position, instead of guessing at class names.
 *
 * Run: npx electron spike/taskbar-inject2.js [--nogpu] [--x=600]
 */
const { app, BrowserWindow } = require('electron');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const HWND = 'uintptr_t';

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const GetWindow = user32.func('__stdcall', 'GetWindow', HWND, [HWND, 'uint']);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', [HWND, koffi.out(koffi.pointer('uint16_t')), 'int']);
const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', [HWND]);
const SetParent = user32.func('__stdcall', 'SetParent', HWND, [HWND, HWND]);
const GetParent = user32.func('__stdcall', 'GetParent', HWND, [HWND]);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', [HWND, 'int', 'intptr_t']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [HWND, 'int']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', [HWND, HWND, 'int', 'int', 'int', 'int', 'uint']);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'bool', [HWND, 'int']);
const BringWindowToTop = user32.func('__stdcall', 'BringWindowToTop', 'bool', [HWND]);

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', [HWND, koffi.out(koffi.pointer(RECT))]);

const GW_CHILD = 5, GW_HWNDNEXT = 2;
const GWL_STYLE = -16, GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000, WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000;
const WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x8000000;
const HWND_TOP = 0;
const SWP_SHOWWINDOW = 0x40, SWP_NOACTIVATE = 0x10;
const SW_SHOW = 5;

const argX = Number((process.argv.find(a => a.startsWith('--x=')) || '--x=600').split('=')[1]);
if (process.argv.includes('--nogpu')) app.disableHardwareAcceleration();

const className = (h) => {
  const buf = new Uint16Array(256);
  const n = GetClassNameW(h, buf, 256);
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le');
};

const rectOf = (h) => { const r = {}; return GetWindowRect(h, r) ? r : null; };

function walkChildren(hParent, mark) {
  // Real z-order: GW_CHILD gives the topmost child, GW_HWNDNEXT descends.
  console.log('\n--- Shell_TrayWnd children, topmost first ---');
  let h = GetWindow(hParent, GW_CHILD);
  let i = 0;
  while (h && h.toString() !== '0') {
    const r = rectOf(h);
    const isUs = mark && h.toString() === mark.toString();
    console.log(
      `  [${String(i).padStart(2)}] ${isUs ? '>>> ' : '    '}${className(h).padEnd(46)}` +
      ` vis=${IsWindowVisible(h) ? 'Y' : 'n'}` +
      ` rect=${r ? `${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}` : '?'}`
    );
    h = GetWindow(h, GW_HWNDNEXT);
    i++;
    if (i > 40) break;
  }
}

const hwndOf = (win) => {
  const b = win.getNativeWindowHandle();
  return b.length === 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0));
};

const decodeEx = (ex) => [
  [WS_EX_LAYERED, 'LAYERED'], [WS_EX_TOOLWINDOW, 'TOOLWINDOW'],
  [WS_EX_NOACTIVATE, 'NOACTIVATE'], [WS_EX_APPWINDOW, 'APPWINDOW'],
].filter(([bit]) => BigInt(ex) & BigInt(bit)).map(([, n]) => n).join('|') || 'none';

app.whenReady().then(() => {
  const hTaskbar = FindWindowW('Shell_TrayWnd', null);
  const tb = rectOf(hTaskbar);
  const H = tb.bottom - tb.top;
  console.log(`GPU: ${process.argv.includes('--nogpu') ? 'DISABLED' : 'enabled'}   taskbar h=${H}`);

  walkChildren(hTaskbar, null);

  const wantTransparent = process.argv.includes('--transparent');

  const win = new BrowserWindow({
    width: 220, height: H,
    frame: false, transparent: wantTransparent, resizable: false,
    skipTaskbar: true, focusable: !process.argv.includes('--nofocus'), show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // Transparent variant paints NO background: if the taskbar's acrylic shows
  // through around the text, a child window can be layered inside Shell_TrayWnd
  // and the widget can look native instead of like a pasted rectangle.
  win.loadURL('data:text/html,' + encodeURIComponent(wantTransparent ? `
    <body style="margin:0;background:transparent;color:#fff;font:600 12px Segoe UI;
                 display:flex;align-items:center;gap:8px;height:100vh;padding:0 10px">
      <span>Weekly usage</span>
      <span style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.25)">
        <i style="display:block;width:63%;height:100%;border-radius:3px;background:#45b972"></i>
      </span>
      <span>63%</span>
    </body>` : `
    <body style="margin:0;background:#c026d3;color:#fff;font:600 13px Segoe UI;
                 display:flex;align-items:center;justify-content:center;height:100vh">SPIKE 2</body>`));

  win.webContents.once('did-finish-load', () => setTimeout(() => {
    const hwnd = hwndOf(win);
    console.log(`\nElectron hwnd=0x${hwnd.toString(16)}  class=${className(hwnd)}`);
    console.log(`exStyle before: ${decodeEx(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))}`);

    SetParent(hwnd, BigInt(hTaskbar));

    let style = (BigInt(GetWindowLongPtrW(hwnd, GWL_STYLE)) | BigInt(WS_CHILD | WS_VISIBLE)) & ~BigInt(WS_POPUP);
    SetWindowLongPtrW(hwnd, GWL_STYLE, style);
    // Keep WS_EX_LAYERED when we asked for transparency — stripping it is what
    // would force the window opaque.
    let ex = (BigInt(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) | BigInt(WS_EX_TOOLWINDOW)) & ~BigInt(WS_EX_APPWINDOW);
    if (!wantTransparent) ex &= ~BigInt(WS_EX_LAYERED);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);

    SetWindowPos(hwnd, HWND_TOP, argX, 0, 220, H, SWP_SHOWWINDOW | SWP_NOACTIVATE);
    ShowWindow(hwnd, SW_SHOW);
    BringWindowToTop(hwnd);

    const r = rectOf(hwnd);
    console.log(`\nAfter reparent:`);
    console.log(`  GetParent   = 0x${GetParent(hwnd).toString(16)} (taskbar=0x${hTaskbar.toString(16)})`);
    console.log(`  IsVisible   = ${IsWindowVisible(hwnd)}`);
    console.log(`  screen rect = ${r ? `${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}` : '?'}`);
    console.log(`  exStyle     = ${decodeEx(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))}`);

    walkChildren(hTaskbar, hwnd);
  }, 400));
});

app.on('window-all-closed', () => app.quit());
