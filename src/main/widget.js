/**
 * Hosts the one widget renderer on both platforms.
 *
 * Neither platform shows the BrowserWindow. It paints offscreen and the result
 * is captured to a bitmap, which then becomes:
 *   - macOS: the NSStatusItem image, via Tray.
 *   - Windows: the pixels of a real Win32 window living inside the taskbar.
 *
 * Windows needs that native window because an embedded Electron window never
 * receives mouse input — see the long note at the top of win32-taskbar.js. The
 * happy accident is that both platforms now want the same thing, a bitmap, so
 * there is a single renderer and a single set of strings behind both surfaces.
 */
const path = require('path');
const { BrowserWindow, Tray, nativeImage, nativeTheme } = require('electron');

const IS_MAC = process.platform === 'darwin';
const MENU_BAR_HEIGHT = 22;

class Widget {
  constructor({ onClick }) {
    this.onClick = onClick;
    this.win = null;
    this.tray = null;
    this.strip = null;        // TaskbarStrip, Windows only
    this.lastView = null;
    this.captureQueued = false;
    // Clickable regions the renderer laid out, in widget-local pixels.
    this.hits = [];
  }

  /**
   * What was clicked, given a point inside the widget.
   *
   * The page itself can never receive a click — it is only ever captured to a
   * bitmap — so the renderer reports where it put things and the hit test
   * happens here against the coordinates the native surface gives us.
   */
  hitAt(point) {
    if (!point) return null;
    const hit = this.hits.find((h) => point.x >= h.x && point.x < h.x + h.width
      && point.y >= h.y && point.y < h.y + h.height);
    return hit ? hit.action : null;
  }

  create() {
    this.win = new BrowserWindow({
      width: 260,
      height: IS_MAC ? MENU_BAR_HEIGHT : 48,
      show: false,
      frame: false,
      // The capture must carry alpha: both surfaces composite it per-pixel.
      transparent: true,
      resizable: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'widget.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'widget', 'widget.html'));

    // The widget renderer is never shown, so its console is otherwise unreachable
    // and its errors are silent. --verbose surfaces them. (Not --debug: that is a
    // retired Node flag and Electron refuses to start when it sees it.)
    if (process.argv.includes('--verbose')) {
      this.win.webContents.on('console-message', (_e, _level, message) => {
        console.log('[widget renderer]', message);
      });
    }

    if (IS_MAC) {
      this.tray = new Tray(nativeImage.createEmpty());
      // bounds is the status item's frame and position is where the click landed,
      // both in screen coordinates — the difference is the widget-local point.
      this.tray.on('click', (_e, bounds, position) => this.onClick('left', {
        x: Math.round((position?.x ?? 0) - (bounds?.x ?? 0)),
        y: Math.round((position?.y ?? 0) - (bounds?.y ?? 0)),
      }));
      this.tray.on('right-click', () => this.onClick('right'));
    } else {
      const { TaskbarStrip } = require('./win32-taskbar');
      this.strip = new TaskbarStrip({ onClick: this.onClick });
      this.strip.create();
      this.strip.watch();
    }

    nativeTheme.on('updated', () => {
      if (this.lastView) this.setView({ ...this.lastView, dark: nativeTheme.shouldUseDarkColors });
    });

    return this.win;
  }

  setView(view) {
    this.lastView = view;
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('widget:state', view);
    }
  }

  /** Called when the renderer reports the size it just painted. */
  onRendered({ width, height, hits }) {
    this.hits = hits ?? [];
    if (process.argv.includes('--verbose') && this.hits.length) {
      console.log('[widget] hit regions:', JSON.stringify(this.hits));
    }
    if (!this.win || this.win.isDestroyed()) return;
    const w = Math.max(1, width);
    const h = Math.max(1, IS_MAC ? MENU_BAR_HEIGHT : height);
    this.win.setSize(w, h);
    this.queueCapture(w, h);
  }

  /**
   * Capture is debounced: a language change or a countdown tick can fire several
   * renders back to back, and each capture is comparatively expensive.
   */
  queueCapture(width, height) {
    if (this.captureQueued) return;
    this.captureQueued = true;
    setTimeout(async () => {
      this.captureQueued = false;
      if (!this.win || this.win.isDestroyed()) return;
      try {
        const image = await this.win.webContents.capturePage({ x: 0, y: 0, width, height });
        if (image.isEmpty()) return;

        if (IS_MAC) {
          this.tray.setImage(image);
          return;
        }

        // Derive the real pixel size from the buffer rather than trusting the
        // logical size: on a HiDPI display the capture comes back scaled.
        const size = image.getSize();
        const buffer = image.getBitmap();
        const scale = Math.max(1, Math.round(Math.sqrt(buffer.length / 4 / (size.width * size.height))));
        this.strip.setBitmap(buffer, size.width * scale, size.height * scale);
      } catch (err) {
        console.error('[widget] capture failed:', err.message);
      }
    }, 60);
  }

  popUpMenu(menu) {
    if (IS_MAC && this.tray) {
      this.tray.popUpContextMenu(menu);
      return;
    }
    // Anchored at the cursor, which is where the click came from.
    menu.popup();
  }

  destroy() {
    if (this.strip) this.strip.destroy();
    if (this.tray) this.tray.destroy();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { Widget, IS_MAC };
