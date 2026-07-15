/**
 * Hosts the one widget renderer on both platforms.
 *
 * Windows: the window is real and visible, reparented into Shell_TrayWnd, and
 * resized to whatever the renderer painted.
 * macOS: the same window is never shown. It renders offscreen, gets captured to
 * a bitmap, and that bitmap becomes the NSStatusItem image via Tray.
 *
 * One renderer, one set of strings, two very different delivery mechanisms.
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
    this.host = null;         // TaskbarHost, Windows only
    this.lastView = null;
    this.captureQueued = false;
  }

  create() {
    this.win = new BrowserWindow({
      width: 260,
      height: IS_MAC ? MENU_BAR_HEIGHT : 48,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      // Must stay false: a focusable widget becomes the foreground window and
      // steals focus from whatever the user is typing in. popUpMenu() lends it
      // focusability for the lifetime of the context menu instead.
      focusable: false,
      hasShadow: false,
      useContentSize: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'widget.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'widget', 'widget.html'));

    if (IS_MAC) {
      this.tray = new Tray(nativeImage.createEmpty());
      this.tray.on('click', () => this.onClick('left'));
      this.tray.on('right-click', () => this.onClick('right'));
    } else {
      // Attach only once there are pixels to show, so the taskbar never gets a
      // blank rectangle wedged into it.
      this.win.webContents.once('did-finish-load', () => {
        const { TaskbarHost } = require('./win32-taskbar');
        this.host = new TaskbarHost(this.win);
        this.win.showInactive();
        this.host.attach();
        this.host.watch();
      });
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
  onRendered({ width, height }) {
    if (!this.win || this.win.isDestroyed()) return;

    if (IS_MAC) {
      this.win.setContentSize(Math.max(1, width), MENU_BAR_HEIGHT);
      this.queueCapture(width);
      return;
    }

    // Windows: never touch Electron's own sizing API here. setContentSize
    // re-applies the bounds Electron cached before the reparent, which drags the
    // window back out of the taskbar and up over the wallpaper. Once we are a
    // child of Shell_TrayWnd, SetWindowPos is the only thing allowed to move us.
    if (this.host) this.host.setDesiredWidth(width);
  }

  /**
   * Capture is debounced: a language change or a countdown tick can fire several
   * renders back to back, and each capture is comparatively expensive.
   */
  queueCapture(width) {
    if (this.captureQueued) return;
    this.captureQueued = true;
    setTimeout(async () => {
      this.captureQueued = false;
      if (!this.win || this.win.isDestroyed() || !this.tray) return;
      try {
        const image = await this.win.webContents.capturePage({
          x: 0, y: 0, width: Math.max(1, width), height: MENU_BAR_HEIGHT,
        });
        if (!image.isEmpty()) this.tray.setImage(image);
      } catch (err) {
        console.error('[widget] menu bar capture failed:', err.message);
      }
    }, 60);
  }

  setContextMenu(menu) {
    this.contextMenu = menu;
  }

  popUpMenu(menu) {
    if (IS_MAC && this.tray) {
      this.tray.popUpContextMenu(menu);
      return;
    }
    if (!this.win) return;

    // A WS_EX_NOACTIVATE window (focusable: false) cannot host a popup menu: the
    // menu needs focus to stay open, so it dismisses itself the frame it
    // appears — silently, with no error. Lend the window focusability for the
    // lifetime of the menu, then take it back so ordinary clicks still don't
    // steal focus from whatever the user was working in.
    this.win.setFocusable(true);
    this.win.focus();
    menu.popup({
      window: this.win,
      callback: () => this.win.setFocusable(false),
    });
  }

  destroy() {
    if (this.host) this.host.detach();
    if (this.tray) this.tray.destroy();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { Widget, IS_MAC };
