/**
 * The Windows taskbar strip: a real Win32 window, created and owned by us.
 *
 * WHY NOT AN ELECTRON WINDOW
 * An earlier version reparented the Electron BrowserWindow itself into
 * explorer.exe's Shell_TrayWnd. It rendered beautifully and never received a
 * single mouse message. A control experiment settled it: the same window, the
 * same window-procedure subclass and the same synthetic click worked perfectly
 * while the window floated on the desktop, and went silent the moment it was
 * embedded. Every configuration difference against the reference implementation
 * (TrafficMonitor) was eliminated one at a time — WS_CHILD, WS_EX_TRANSPARENT,
 * WS_EX_NOACTIVATE, transparency, background alpha, WM_MOUSEACTIVATE — and none
 * of them was the cause. What remains is structural: TrafficMonitor embeds one
 * plain Win32 window, while Electron embeds Chromium, which nests a
 * Chrome_RenderWidgetHostHWND inside a Chrome_WidgetWin_1 and runs its own input
 * plumbing on top. That plumbing does not deliver once embedded.
 *
 * So this file does what the reference does: a plain window, our own window
 * procedure, WM_LBUTTONUP / WM_RBUTTONUP read straight off the queue. The widget
 * is still the same HTML renderer — it paints offscreen and we blit the captured
 * bitmap here, exactly as the macOS menu bar path already does. One renderer,
 * one set of strings, three surfaces.
 */
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const HWND = 'uintptr_t';
const HANDLE = 'void*';

// --- structs ---

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const PAINTSTRUCT = koffi.struct('PAINTSTRUCT', {
  hdc: HANDLE,
  fErase: 'int',
  rcPaint: RECT,
  fRestore: 'int',
  fIncUpdate: 'int',
  rgbReserved: koffi.array('uint8', 32),
});

const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'long',
  biHeight: 'long',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'long',
  biYPelsPerMeter: 'long',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
});

const WndProcProto = koffi.proto('__stdcall', 'UsageBarWndProc', 'intptr_t',
  [HWND, 'uint', 'uintptr_t', 'intptr_t']);

const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
  cbSize: 'uint32',
  style: 'uint32',
  lpfnWndProc: koffi.pointer(WndProcProto),
  cbClsExtra: 'int',
  cbWndExtra: 'int',
  hInstance: HANDLE,
  hIcon: HANDLE,
  hCursor: HANDLE,
  hbrBackground: HANDLE,
  lpszMenuName: 'str16',
  lpszClassName: 'str16',
  hIconSm: HANDLE,
});

// --- functions ---

const GetModuleHandleW = kernel32.func('__stdcall', 'GetModuleHandleW', HANDLE, ['str16']);
const RegisterClassExW = user32.func('__stdcall', 'RegisterClassExW', 'uint16', [koffi.pointer(WNDCLASSEXW)]);
const CreateWindowExW = user32.func('__stdcall', 'CreateWindowExW', HWND,
  ['uint32', 'str16', 'str16', 'uint32', 'int', 'int', 'int', 'int', HWND, HANDLE, HANDLE, HANDLE]);
const SetParent = user32.func('__stdcall', 'SetParent', HWND, [HWND, HWND]);
const DestroyWindow = user32.func('__stdcall', 'DestroyWindow', 'bool', [HWND]);
const DefWindowProcW = user32.func('__stdcall', 'DefWindowProcW', 'intptr_t', [HWND, 'uint', 'uintptr_t', 'intptr_t']);
const LoadCursorW = user32.func('__stdcall', 'LoadCursorW', HANDLE, [HANDLE, 'uintptr_t']);

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HWND, [HWND, HWND, 'str16', 'str16']);
const IsWindow = user32.func('__stdcall', 'IsWindow', 'bool', [HWND]);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', [HWND, koffi.out(koffi.pointer(RECT))]);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', [HWND, HWND, 'int', 'int', 'int', 'int', 'uint']);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'bool', [HWND, 'int']);
const InvalidateRect = user32.func('__stdcall', 'InvalidateRect', 'bool', [HWND, HANDLE, 'bool']);
const SetLayeredWindowAttributes = user32.func('__stdcall', 'SetLayeredWindowAttributes', 'bool',
  [HWND, 'uint32', 'uint8', 'uint32']);
const BeginPaint = user32.func('__stdcall', 'BeginPaint', HANDLE, [HWND, koffi.out(koffi.pointer(PAINTSTRUCT))]);
const EndPaint = user32.func('__stdcall', 'EndPaint', 'bool', [HWND, koffi.pointer(PAINTSTRUCT)]);
const GetCursorPos = user32.func('__stdcall', 'GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))]);

const StretchDIBits = gdi32.func('__stdcall', 'StretchDIBits', 'int',
  [HANDLE, 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int',
    'void*', koffi.pointer(BITMAPINFOHEADER), 'uint', 'uint32']);

// --- constants ---

const CLASS_NAME = 'ClaudeUsageBarStrip';
const CS_HREDRAW = 0x0002, CS_VREDRAW = 0x0001;
const WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000, WS_CLIPSIBLINGS = 0x04000000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_LAYERED = 0x00080000;
const LWA_ALPHA = 0x00000002;
const HWND_TOP = 0;
const SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040, SWP_NOACTIVATE = 0x0010;
const SW_SHOW = 5;
const IDC_ARROW = 32512n;
const DIB_RGB_COLORS = 0;
const SRCCOPY = 0x00CC0020;

const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000F;
const WM_ERASEBKGND = 0x0014;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONUP = 0x0205;

const TRAY_MARGIN = 12;

const rectOf = (h) => { const r = {}; return GetWindowRect(h, r) ? r : null; };
const findTaskbar = () => { const h = FindWindowW('Shell_TrayWnd', null); return h && IsWindow(h) ? h : null; };

/**
 * Where the strip sits inside the taskbar.
 *
 * Right-aligned against the notification area, matching the reference
 * (`notify_x_pos - m_rect.Width() + 2`), so it stays put as apps open and close
 * instead of drifting with the icon band. Landmarks are read live: the icon band
 * grows, and Win11 centres it unless the user left-aligns the taskbar.
 */
function measureSlot(hTaskbar, width, height) {
  const tb = rectOf(hTaskbar);
  if (!tb) return null;

  const barW = tb.right - tb.left;
  const barH = tb.bottom - tb.top;

  const trayRect = rectOf(FindWindowExW(hTaskbar, 0, 'TrayNotifyWnd', null));
  const iconsRect = rectOf(FindWindowExW(hTaskbar, 0, 'ReBarWindow32', null));

  const trayLeft = trayRect ? trayRect.left - tb.left : barW;
  const iconsRight = iconsRect ? iconsRect.right - tb.left : 0;

  return {
    x: Math.max(iconsRight, trayLeft - TRAY_MARGIN - width),
    y: Math.max(0, Math.round((barH - height) / 2)),
    barH,
  };
}

let classRegistered = false;
let classProcCallback = null; // must outlive the class registration

class TaskbarStrip {
  constructor({ onClick } = {}) {
    this.onClick = onClick;
    this.hwnd = null;
    this.hTaskbar = null;
    this.bitmap = null;   // BGRA, top-down
    this.width = 0;
    this.height = 0;
    this.timer = null;
  }

  /**
   * The class is process-wide, and its window procedure outlives any single
   * window, so registration happens once and dispatches to the live instance.
   */
  static ensureClass(host) {
    if (classRegistered) return;

    const proc = (hwnd, msg, wParam, lParam) => {
      const self = TaskbarStrip.current;
      switch (msg) {
        case WM_ERASEBKGND:
          return 1n; // WM_PAINT covers every pixel; erasing first would flicker
        case WM_PAINT:
          if (self) self.paint(hwnd);
          return 0n;
        case WM_LBUTTONUP:
          if (self) setImmediate(() => self.onClick && self.onClick('left'));
          return 0n;
        case WM_RBUTTONUP:
          if (self) setImmediate(() => self.onClick && self.onClick('right'));
          return 0n;
        case WM_DESTROY:
          return 0n;
        default:
          return DefWindowProcW(hwnd, msg, wParam, lParam);
      }
    };

    classProcCallback = koffi.register(proc, koffi.pointer(WndProcProto));

    const wc = {
      cbSize: koffi.sizeof(WNDCLASSEXW),
      style: CS_HREDRAW | CS_VREDRAW,
      lpfnWndProc: classProcCallback,
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance: GetModuleHandleW(null),
      hIcon: null,
      hCursor: LoadCursorW(null, IDC_ARROW),
      hbrBackground: null,
      lpszMenuName: null,
      lpszClassName: CLASS_NAME,
      hIconSm: null,
    };

    if (!RegisterClassExW(wc)) throw new Error('RegisterClassExW failed');
    classRegistered = true;
  }

  create() {
    const hTaskbar = findTaskbar();
    if (!hTaskbar) return false;

    TaskbarStrip.ensureClass();
    TaskbarStrip.current = this;

    // WS_POPUP, and it STAYS WS_POPUP after SetParent. This is the whole trick,
    // and it is the opposite of what the SetParent documentation advises ("clear
    // WS_POPUP and set WS_CHILD after calling SetParent").
    //
    // Ground truth, read live off a running TrafficMonitor sitting in this very
    // taskbar and receiving clicks:
    //
    //   #32770 "TrafficMonitorTaskbarWindow"
    //   style = 0x94080044  POPUP|VISIBLE|CLIPSIBLINGS|SYSMENU
    //
    // A genuine WS_CHILD of Shell_TrayWnd renders fine but never sees the mouse:
    // hit-testing runs through the parent's chain, and the Win11 XAML taskbar
    // swallows it. A reparented popup keeps its own input routing and gets the
    // messages. Do not "fix" this to WS_CHILD.
    // WS_EX_LAYERED is not decoration — without it nothing appears on screen.
    // A reparented popup inside the taskbar paints into its own DC happily
    // (StretchDIBits reports every scanline written) but DWM never composites
    // it. Layered windows are composited separately, which is why the reference
    // carries the flag:
    //
    //   #32770 "TrafficMonitorTaskbarWindow"
    //   exstyle = 0x90080  LAYERED|CONTROLPARENT|TOOLWINDOW
    this.hwnd = CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_LAYERED, CLASS_NAME, 'Claude Usage Bar',
      WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS,
      0, 0, 10, 10,
      0, null, GetModuleHandleW(null), null
    );
    if (!this.hwnd) return false;

    // Opaque: alpha 255 over the whole window. The widget paints its own
    // taskbar-coloured background, so there is nothing to see through.
    SetLayeredWindowAttributes(this.hwnd, 0, 255, LWA_ALPHA);

    if (!SetParent(this.hwnd, BigInt(hTaskbar))) {
      DestroyWindow(this.hwnd);
      this.hwnd = null;
      return false;
    }

    this.hTaskbar = hTaskbar;
    ShowWindow(this.hwnd, SW_SHOW);
    return true;
  }

  /** Hand over what the renderer painted: raw BGRA, top-down, physical pixels. */
  setBitmap(buffer, width, height) {
    this.bitmap = buffer;
    this.width = width;
    this.height = height;
    if (!this.hwnd) return;
    this.position();
    InvalidateRect(this.hwnd, null, false);
  }

  paint(hwnd) {
    const ps = {};
    const hdc = BeginPaint(hwnd, ps);
    if (hdc && this.bitmap) {
      const bmi = {
        biSize: koffi.sizeof(BITMAPINFOHEADER),
        biWidth: this.width,
        biHeight: -this.height, // negative: top-down, matching the capture
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0, // BI_RGB
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
      };
      StretchDIBits(hdc, 0, 0, this.width, this.height, 0, 0, this.width, this.height,
        this.bitmap, bmi, DIB_RGB_COLORS, SRCCOPY);
    }
    EndPaint(hwnd, ps);
  }

  position() {
    if (!this.hwnd || !this.hTaskbar || !this.width) return;
    const slot = measureSlot(this.hTaskbar, this.width, this.height);
    if (!slot) return;
    SetWindowPos(this.hwnd, HWND_TOP, slot.x, slot.y, this.width, this.height,
      SWP_SHOWWINDOW | SWP_NOACTIVATE);
  }

  taskbarHeight() {
    const tb = this.hTaskbar ? rectOf(this.hTaskbar) : null;
    return tb ? tb.bottom - tb.top : 48;
  }

  cursorPos() {
    const p = {};
    return GetCursorPos(p) ? p : { x: 0, y: 0 };
  }

  /**
   * One cheap poll covers every way the taskbar moves out from under us:
   * explorer restarting (a brand new Shell_TrayWnd, and our window dies with the
   * old one), the bar changing edge or monitor, DPI changes, and the icon band
   * growing. Watching for TaskbarCreated alone would miss the last three.
   */
  watch(intervalMs = 1500) {
    this.stopWatching();
    this.timer = setInterval(() => {
      const current = findTaskbar();
      if (!current) return;

      if (!this.hwnd || !IsWindow(this.hwnd) || current.toString() !== this.hTaskbar.toString()) {
        this.hwnd = null;
        if (this.create()) {
          this.position();
          InvalidateRect(this.hwnd, null, false);
        }
        return;
      }
      this.position();
    }, intervalMs);
  }

  stopWatching() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  destroy() {
    this.stopWatching();
    if (this.hwnd && IsWindow(this.hwnd)) {
      try { DestroyWindow(this.hwnd); } catch { /* explorer may already be gone */ }
    }
    this.hwnd = null;
    if (TaskbarStrip.current === this) TaskbarStrip.current = null;
  }
}

TaskbarStrip.current = null;

module.exports = { TaskbarStrip, findTaskbar, measureSlot };
