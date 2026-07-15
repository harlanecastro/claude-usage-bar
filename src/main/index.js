const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, shell, nativeTheme } = require('electron');

const { getSettings, setSettings } = require('./config');
const { Translator, resolveLanguage, availableLanguages } = require('./i18n');
const auth = require('./auth');
const { fetchUsage, isAuthError } = require('./usage');
const { Widget, IS_MAC } = require('./widget');

// NOTE: do not add app.disableHardwareAcceleration() here. With the GPU off,
// Chromium stops painting once the window is reparented into the Windows
// taskbar, and the widget silently disappears. Verified on Windows 11 26200.

const USAGE_PAGE = 'https://claude.ai/new#settings/usage';
const POLL_INTERVAL = 5 * 60 * 1000;
const TICK_INTERVAL = 30 * 1000;   // keeps the reset countdown honest between polls

if (process.platform === 'win32') app.setAppUserModelId('com.harlanecastro.claudeusagebar');

let widget = null;
let settingsWindow = null;
let pollTimer = null;
let tickTimer = null;

const model = {
  state: 'loading',   // loading | ok | signedOut | error
  data: null,
};

function zoneOf(pct, { warn, crit }) {
  if (pct >= crit) return 'crit';
  if (pct >= warn) return 'warn';
  return 'ok';
}

function translator() {
  return new Translator(resolveLanguage(getSettings().language));
}

function buildView() {
  const settings = getSettings();
  const t = translator();
  const base = { platform: process.platform, dark: nativeTheme.shouldUseDarkColors };

  const notice = (label, sub) => ({
    ...base,
    session: null,
    weekly: { label, pct: null, sub, zone: 'ok' },
    monthly: null,
  });

  if (model.state === 'loading') return notice(t.t('widget.loading'), null);
  if (model.state === 'signedOut') return notice(t.t('widget.notSignedIn'), t.t('widget.clickToSignIn'));
  if (model.state === 'error') return notice(t.t('widget.loadFailed'), t.t('widget.clickToRetry'));

  const { session, weekly, monthly } = model.data;

  // Both windows read the same way, so they are built the same way: the label
  // switches to a "limit reached" line once there is nothing left to report.
  const block = (data, usageKey, reachedKey) => ({
    label: data.utilization >= 100 ? t.t(reachedKey) : t.t(usageKey),
    pct: Math.min(100, data.utilization),
    zone: zoneOf(data.utilization, settings.thresholds),
    sub: t.t('widget.resetsIn', { duration: t.duration(data.resetsAt - Date.now()) }),
  });

  const view = {
    ...base,
    session: session ? block(session, 'widget.sessionUsage', 'widget.sessionLimitReached') : null,
    weekly: block(weekly, 'widget.weeklyUsage', 'widget.weeklyLimitReached'),
    monthly: null,
  };

  if (settings.showMonthly && monthly) {
    view.monthly = {
      label: t.t('widget.monthlyUsage'),
      pct: Math.min(100, monthly.utilization),
      zone: zoneOf(monthly.utilization, settings.thresholds),
      sub: IS_MAC ? null : t.t('widget.resetsOn', { date: t.date(monthly.resetsAt) }),
    };
  }

  return view;
}

function paint() {
  if (widget) widget.setView(buildView());
}

async function refresh() {
  if (!auth.isSignedIn()) {
    model.state = 'signedOut';
    return paint();
  }
  try {
    model.data = await fetchUsage({ includeMonthly: getSettings().showMonthly });
    model.state = 'ok';
  } catch (err) {
    // A session that Cloudflare or the API rejects is dead, not merely slow —
    // drop it so the widget invites a fresh sign-in instead of retrying forever.
    if (isAuthError(err)) {
      await auth.signOut();
      model.state = 'signedOut';
    } else {
      console.error('[usage] refresh failed:', err.message);
      model.state = 'error';
    }
  }
  paint();
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  pollTimer = setInterval(refresh, POLL_INTERVAL);
  tickTimer = setInterval(() => { if (model.state === 'ok') paint(); }, TICK_INTERVAL);
}

// ---------- interactions ----------

async function handleClick(button) {
  if (button === 'right') return widget.popUpMenu(buildMenu());

  if (model.state === 'signedOut') return startSignIn();
  if (model.state === 'error') return refresh();
  shell.openExternal(USAGE_PAGE);
}

async function startSignIn() {
  const result = await auth.signIn();
  if (result.ok) {
    model.state = 'loading';
    paint();
    await refresh();
    if (settingsWindow) settingsWindow.webContents.send('settings:auth', auth.isSignedIn());
  }
}

function buildMenu() {
  const t = translator();
  const settings = getSettings();
  const signedIn = auth.isSignedIn();

  const items = [];

  if (model.state === 'ok') {
    const view = buildView();
    items.push({ label: `${view.weekly.label} ${Math.round(view.weekly.pct)}%`, enabled: false });
    items.push({ label: view.weekly.sub, enabled: false });
    items.push({ type: 'separator' });
  }

  items.push({ label: t.t('menu.openUsagePage'), click: () => shell.openExternal(USAGE_PAGE) });
  items.push({ label: t.t('menu.refreshNow'), click: () => refresh() });
  items.push({ type: 'separator' });
  items.push({ label: t.t('menu.settings'), accelerator: IS_MAC ? 'Cmd+,' : 'Ctrl+,', click: openSettings });
  items.push({
    label: t.t('menu.startAtLogin'),
    type: 'checkbox',
    checked: settings.startAtLogin,
    click: (item) => applyStartAtLogin(item.checked),
  });
  items.push({ type: 'separator' });
  items.push(signedIn
    ? { label: t.t('menu.signOut'), click: async () => { await auth.signOut(); model.state = 'signedOut'; paint(); } }
    : { label: t.t('menu.signIn'), click: startSignIn });
  items.push({ type: 'separator' });
  items.push({ label: t.t('menu.quit'), click: () => app.quit() });

  return Menu.buildFromTemplate(items);
}

function applyStartAtLogin(enabled) {
  setSettings({ startAtLogin: enabled });
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 720,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: translator().t('settings.windowTitle'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161c22' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------- ipc ----------

ipcMain.on('widget:rendered', (_e, size) => widget && widget.onRendered(size));
ipcMain.on('widget:click', (_e, button) => handleClick(button));

ipcMain.handle('settings:get', () => ({
  settings: getSettings(),
  languages: availableLanguages(),
  strings: translator().dict,
  signedIn: auth.isSignedIn(),
  resolvedLanguage: resolveLanguage(getSettings().language),
}));

ipcMain.handle('settings:set', async (_e, patch) => {
  const before = getSettings();
  const after = setSettings(patch);

  // Turning the monthly meter on needs a payload we did not request last poll.
  if (after.showMonthly && !before.showMonthly && model.state === 'ok') await refresh();
  else paint();

  return {
    settings: after,
    strings: translator().dict,
    resolvedLanguage: resolveLanguage(after.language),
  };
});

ipcMain.handle('settings:signIn', async () => {
  await startSignIn();
  return auth.isSignedIn();
});

ipcMain.handle('settings:signOut', async () => {
  await auth.signOut();
  model.state = 'signedOut';
  paint();
  return false;
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openSettings);

  app.whenReady().then(async () => {
    auth.applyUserAgent();
    if (IS_MAC && app.dock) app.dock.hide();

    widget = new Widget({ onClick: handleClick });
    widget.create();
    paint();

    await auth.restore();
    await refresh();
    schedulePolling();
  });

  app.on('before-quit', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (widget) widget.destroy();
  });

  // The widget is the app: closing the settings window must not end the process.
  app.on('window-all-closed', () => {});
}
