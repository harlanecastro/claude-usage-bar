/**
 * Injects the widget window into the real Windows taskbar.
 *
 * The widget is not a floating window sitting on top of the taskbar — it is
 * SetParent'd into explorer.exe's Shell_TrayWnd and becomes an actual child of
 * it, the same technique TrafficMonitor uses (TaskBarDlg.cpp). Consequences:
 * other windows can never cover it, it slides away with auto-hide, and it
 * follows the taskbar across DPI and layout changes.
 *
 * Every constant below was verified against a live Windows 11 26200 taskbar
 * (see spike/taskbar-inject2.js). Two of them are load-bearing and easy to
 * break by "cleaning up":
 *   - The app must NOT call disableHardwareAcceleration(): with the GPU off,
 *     Chromium stops painting once reparented.
 *   - WS_EX_LAYERED must survive: stripping it forces the window opaque and
 *     the widget turns into a grey rectangle pasted over the taskbar acrylic.
 */
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const HWND = 'uintptr_t';

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HWND, [HWND, HWND, 'str16', 'str16']);
const SetParent = user32.func('__stdcall', 'SetParent', HWND, [HWND, HWND]);
const GetParent = user32.func('__stdcall', 'GetParent', HWND, [HWND]);
const IsWindow = user32.func('__stdcall', 'IsWindow', 'bool', [HWND]);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', [HWND, 'int', 'intptr_t']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [HWND, 'int']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', [HWND, HWND, 'int', 'int', 'int', 'int', 'uint']);

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', [HWND, koffi.out(koffi.pointer(RECT))]);

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000n;
const WS_POPUP = 0x80000000n;
const WS_VISIBLE = 0x10000000n;
const WS_EX_TOOLWINDOW = 0x00000080n;
const WS_EX_APPWINDOW = 0x00040000n;
const HWND_TOP = 0;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOACTIVATE = 0x0010;

// Gap kept between the widget and the notification area, in taskbar pixels.
const TRAY_MARGIN = 12;

function rectOf(hwnd) {
  const r = {};
  return GetWindowRect(hwnd, r) ? r : null;
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function findTaskbar() {
  const h = FindWindowW('Shell_TrayWnd', null);
  return h && IsWindow(h) ? h : null;
}

/**
 * Where the widget may sit inside the taskbar.
 *
 * The free span runs from the right edge of the icon band (ReBarWindow32) to
 * the left edge of the notification area (TrayNotifyWnd). Both are read live
 * rather than assumed: the icon band grows as apps open, and Win11 centres it
 * unless the user left-aligns, so the numbers move under us.
 */
function measureSlot(hTaskbar, desiredWidth) {
  const tb = rectOf(hTaskbar);
  if (!tb) return null;

  const height = tb.bottom - tb.top;
  const taskbarWidth = tb.right - tb.left;

  const hTray = FindWindowExW(hTaskbar, 0, 'TrayNotifyWnd', null);
  const hIcons = FindWindowExW(hTaskbar, 0, 'ReBarWindow32', null);

  const trayRect = hTray ? rectOf(hTray) : null;
  const iconsRect = hIcons ? rectOf(hIcons) : null;

  // Coordinates are relative to the taskbar's own client area once we are its child.
  const trayLeft = trayRect ? trayRect.left - tb.left : taskbarWidth;
  const iconsRight = iconsRect ? iconsRect.right - tb.left : 0;

  const available = trayLeft - TRAY_MARGIN - iconsRight;
  if (available <= 0) return null;

  const width = Math.min(desiredWidth, available);
  // Right-align against the notification area: the widget stays put as apps
  // open and close, instead of drifting with the icon band's right edge.
  const x = trayLeft - TRAY_MARGIN - width;

  return { x, y: 0, width, height, taskbarWidth };
}

class TaskbarHost {
  constructor(win) {
    this.win = win;
    this.hwnd = hwndOf(win);
    this.hTaskbar = null;
    this.desiredWidth = 260;
    this.lastSlot = null;
    this.attached = false;
    this.timer = null;
  }

  applyStyles() {
    const style = (BigInt(GetWindowLongPtrW(this.hwnd, GWL_STYLE)) | WS_CHILD | WS_VISIBLE) & ~WS_POPUP;
    SetWindowLongPtrW(this.hwnd, GWL_STYLE, style);

    // WS_EX_LAYERED is deliberately left alone — see the file header.
    const ex = (BigInt(GetWindowLongPtrW(this.hwnd, GWL_EXSTYLE)) | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    SetWindowLongPtrW(this.hwnd, GWL_EXSTYLE, ex);
  }

  attach() {
    const hTaskbar = findTaskbar();
    if (!hTaskbar) return false;

    if (!SetParent(this.hwnd, BigInt(hTaskbar))) return false;
    this.hTaskbar = hTaskbar;
    this.applyStyles();
    this.attached = true;
    this.lastSlot = null; // force a reposition against the new parent
    this.position();
    return true;
  }

  position() {
    if (!this.hTaskbar) return;
    const slot = measureSlot(this.hTaskbar, this.desiredWidth);
    if (!slot) return;

    // Compare against where the window ACTUALLY is rather than against what we
    // last asked for. Electron re-applies its own cached bounds on some
    // operations, so trusting our bookkeeping would let the widget drift out of
    // the taskbar and stay there — the poll would see "already correct" and
    // never fix it.
    const tb = rectOf(this.hTaskbar);
    const cur = rectOf(this.hwnd);
    if (tb && cur
      && cur.left - tb.left === slot.x
      && cur.top - tb.top === slot.y
      && cur.right - cur.left === slot.width
      && cur.bottom - cur.top === slot.height) {
      return;
    }

    SetWindowPos(this.hwnd, HWND_TOP, slot.x, slot.y, slot.width, slot.height,
      SWP_SHOWWINDOW | SWP_NOACTIVATE);
    this.lastSlot = slot;
  }

  setDesiredWidth(width) {
    const next = Math.max(80, Math.ceil(width));
    if (next === this.desiredWidth) return;
    this.desiredWidth = next;
    this.lastSlot = null;
    this.position();
  }

  /**
   * One cheap poll covers every way the taskbar can move out from under us:
   * explorer.exe restarting (new Shell_TrayWnd), the bar switching edges or
   * monitors, DPI changes, and the icon band growing. Watching for
   * TaskbarCreated alone would miss the last three.
   */
  watch(intervalMs = 1500) {
    this.stopWatching();
    this.timer = setInterval(() => {
      if (this.win.isDestroyed()) return this.stopWatching();

      const current = findTaskbar();
      if (!current) {
        this.attached = false;
        return;
      }
      const lost = !this.attached
        || current.toString() !== (this.hTaskbar || '').toString()
        || GetParent(this.hwnd).toString() !== current.toString();

      if (lost) this.attach();
      else this.position();
    }, intervalMs);
  }

  stopWatching() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Hand the window back to the desktop so explorer is not left with a dead child. */
  detach() {
    this.stopWatching();
    if (!this.attached) return;
    try {
      SetParent(this.hwnd, 0n);
      this.attached = false;
    } catch { /* explorer may already be gone */ }
  }
}

module.exports = { TaskbarHost, findTaskbar, measureSlot };
