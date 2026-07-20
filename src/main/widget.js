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
const { BrowserWindow, Tray, nativeImage, nativeTheme, screen } = require('electron');

const IS_MAC = process.platform === 'darwin';
const MENU_BAR_HEIGHT = 22;

/**
 * Tags a capture with the scale it was really drawn at.
 *
 * capturePage hands back a HiDPI screen's device pixels — 598x44 for a 299x22
 * widget at 2x — but reports them as a 1x image. The status item then reads every
 * pixel as a point: the widget comes out twice as wide and its 44 points of
 * content are crushed into a 24pt menu bar. The pixels are right, only the scale
 * they claim is wrong, so this rebuilds the same buffer with the correct
 * scaleFactor — which also keeps the Retina detail that resizing would throw away.
 *
 * Verified on macOS 12: without this the item measures 603pt wide, with it 304pt,
 * the same as a 1x screen.
 */
function atDisplayScale(image, logicalWidth) {
  const px = image.getSize();
  // The ratio the pixels themselves prove, not a rounded guess: a fractional
  // scale rounded to the nearest whole number lands on the wrong size entirely
  // (a 1.5x capture tagged as 2x reports 224pt where it owes 299).
  const scale = px.width / Math.max(1, logicalWidth);
  if (scale <= 1) return image;
  return nativeImage.createFromBitmap(image.getBitmap(), {
    width: px.width,
    height: px.height,
    scaleFactor: scale,
  });
}

class Widget {
  constructor({ onClick, resolveTarget }) {
    this.onClick = onClick;
    this.resolveTarget = resolveTarget;
    this.win = null;
    this.tray = null;
    this.strip = null;        // TaskbarStrip, Windows only
    this.lastView = null;
    this.captureQueued = false;
    // Clickable regions the renderer laid out, in widget-local pixels.
    this.hits = [];
    // The size of the image last handed to the host surface. The hit regions are
    // laid out against this, not against whatever frame the host gives the image.
    this.lastSize = { width: 0, height: 0 };
  }

  /**
   * Where a click landed inside the widget, in the renderer's own coordinates.
   *
   * Deliberately ignores the `position` the tray event hands us. On macOS that
   * point does not mean what the name suggests: it comes from the status item's
   * own window, so its x is already item-local while its y is measured up from
   * the bottom of the display. Subtracting the item's screen bounds from it — as
   * this did — produced an x of roughly minus-the-screen-width and a y of about
   * 890 on a 900px display. No hit region could ever contain that, so hitAt()
   * returned null for every click, and every click fell through to the panel.
   * That is the whole bug: the badge never cycled because the badge was never hit.
   *
   * The cursor's screen position is unambiguous by contract and is exactly where
   * the click just happened, so it is what we measure from.
   */
  localPoint(bounds) {
    if (!bounds) return null;
    const cursor = screen.getCursorScreenPoint();
    // The host centres the image inside a slightly roomier item — macOS reports a
    // 304pt frame around a 299pt image — and the renderer measured its regions
    // against the image. Take the padding back off before hit-testing.
    const padX = Math.max(0, (bounds.width - this.lastSize.width) / 2);
    const padY = Math.max(0, (bounds.height - this.lastSize.height) / 2);
    return {
      x: Math.round(cursor.x - bounds.x - padX),
      y: Math.round(cursor.y - bounds.y - padY),
    };
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

  /** Where the widget sits on screen, for anything that needs to point at it. */
  anchorRect() {
    if (IS_MAC && this.tray) {
      const b = this.tray.getBounds();
      return { x: b.x, y: b.y + b.height, width: b.width, height: b.height };
    }
    const rect = this.strip?.screenRect();
    return rect ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  /** Nudges the strip to re-resolve its taskbar and alignment right now. */
  retarget() {
    if (this.strip) this.strip.rebuild();
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
      // bounds is the status item's frame in screen coordinates; where the click
      // landed inside it comes from the cursor, not from the event — see
      // localPoint().
      this.tray.on('click', (_e, bounds) => this.onClick('left', this.localPoint(bounds)));
      this.tray.on('right-click', () => this.onClick('right'));
    } else {
      const { TaskbarStrip } = require('./win32-taskbar');
      this.strip = new TaskbarStrip({ onClick: this.onClick, resolve: this.resolveTarget });
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
    this.lastSize = { width: w, height: h };
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
          this.tray.setImage(atDisplayScale(image, width));
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
