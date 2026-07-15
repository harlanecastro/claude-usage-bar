/**
 * SPIKE — not part of the app.
 *
 * Question this answers: can an Electron (Chromium) window survive being
 * reparented into explorer.exe's Shell_TrayWnd and still render, on this
 * machine's Windows 11 build?
 *
 * TrafficMonitor does exactly this from MFC/GDI+ (TaskBarDlg.cpp):
 *     hTaskbar = ::FindWindow(_T("Shell_TrayWnd"), NULL);
 *     SetParent(this->m_hWnd, GetParentHwnd());
 * A Chromium window is a much heavier guest. Verify before building on it.
 *
 * Run:  npx electron spike/taskbar-inject.js
 * Look at the LEFT side of your taskbar for a magenta strip reading "SPIKE".
 */
const { app, BrowserWindow } = require('electron');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const HWND = 'uintptr_t';

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HWND, [HWND, HWND, 'str16', 'str16']);
const SetParent = user32.func('__stdcall', 'SetParent', HWND, [HWND, HWND]);
const GetParent = user32.func('__stdcall', 'GetParent', HWND, [HWND]);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', [HWND, 'int', 'intptr_t']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [HWND, 'int']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', [HWND, HWND, 'int', 'int', 'int', 'int', 'uint']);
const GetLastError = koffi.load('kernel32.dll').func('__stdcall', 'GetLastError', 'uint32', []);

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', [HWND, koffi.out(koffi.pointer(RECT))]);

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const HWND_TOP = 0;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOACTIVATE = 0x0010;

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function rectOf(hwnd) {
  const r = {};
  return GetWindowRect(hwnd, r) ? r : null;
}

function probeTaskbarChildren(hTaskbar) {
  // Walk the direct children of Shell_TrayWnd so we can see how Win11 lays
  // the XAML taskbar out, and where there might be room for a guest window.
  const classes = [
    'Start', 'TrayDummySearchControl', 'ReBarWindow32', 'MSTaskSwWClass',
    'TrayNotifyWnd', 'Windows.UI.Composition.DesktopWindowXamlSource',
    'TrayShowDesktopButtonWClass',
  ];
  console.log('\n--- Shell_TrayWnd children ---');
  for (const cls of classes) {
    const h = FindWindowExW(hTaskbar, 0, cls, null);
    if (!h) { console.log(`  ${cls.padEnd(48)} : absent`); continue; }
    const r = rectOf(h);
    console.log(`  ${cls.padEnd(48)} : hwnd=0x${h.toString(16)} rect=${r ? `${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}` : '?'}`);
  }
}

app.disableHardwareAcceleration(); // one suspect for compositing failures inside a foreign window tree

app.whenReady().then(() => {
  const hTaskbar = FindWindowW('Shell_TrayWnd', null);
  if (!hTaskbar) {
    console.error('FAIL: Shell_TrayWnd not found.');
    return;
  }

  const tb = rectOf(hTaskbar);
  console.log(`Shell_TrayWnd hwnd=0x${hTaskbar.toString(16)}`);
  console.log(`Taskbar rect: ${tb.left},${tb.top} ${tb.right - tb.left}x${tb.bottom - tb.top}`);
  probeTaskbarChildren(hTaskbar);

  const H = tb.bottom - tb.top;
  const win = new BrowserWindow({
    width: 220,
    height: H,
    frame: false,
    transparent: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.loadURL('data:text/html,' + encodeURIComponent(`
    <body style="margin:0;background:#c026d3;color:#fff;font:600 13px Segoe UI;
                 display:flex;align-items:center;justify-content:center;height:100vh">
      SPIKE — rendering inside the taskbar
    </body>`));

  win.webContents.once('did-finish-load', () => {
    const hwnd = hwndOf(win);
    console.log(`\nElectron hwnd=0x${hwnd.toString(16)}`);

    const parented = SetParent(hwnd, BigInt(hTaskbar));
    console.log(`SetParent -> ${parented ? '0x' + parented.toString(16) : 'NULL'}  lastError=${GetLastError()}`);

    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    style = (BigInt(style) | BigInt(WS_CHILD | WS_VISIBLE)) & ~BigInt(WS_POPUP);
    SetWindowLongPtrW(hwnd, GWL_STYLE, style);

    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    ex = (BigInt(ex) | BigInt(WS_EX_TOOLWINDOW)) & ~BigInt(WS_EX_APPWINDOW);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);

    // Park it at the far left of the taskbar — clear of the Win11 centered
    // icon cluster, so if it draws at all we will see it.
    const ok = SetWindowPos(hwnd, HWND_TOP, 8, 0, 220, H, SWP_SHOWWINDOW | SWP_NOACTIVATE);
    console.log(`SetWindowPos -> ${ok}  lastError=${GetLastError()}`);

    const newParent = GetParent(hwnd);
    console.log(`GetParent(self) -> 0x${newParent.toString(16)}  (want 0x${hTaskbar.toString(16)})`);
    console.log(`\nVERDICT: parent ${newParent.toString() === hTaskbar.toString() ? 'ATTACHED' : 'NOT attached'} — now LOOK at the taskbar.`);
  });
});

app.on('window-all-closed', () => app.quit());
