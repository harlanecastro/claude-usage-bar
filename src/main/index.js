const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, shell, nativeTheme, screen } = require('electron');

const { getSettings, setSettings } = require('./config');
const { Translator, resolveLanguage, availableLanguages } = require('./i18n');
const auth = require('./auth');
const { fetchUsage, isAuthError } = require('./usage');
const { activeSessions } = require('./claude-status');
const { hostMonitors, resolveTaskbar } = require('./monitors');
const { CRAB_FRAMES, CRAB_FPS } = require('../shared/status-frames');
const { Widget, IS_MAC } = require('./widget');

// NOTE: do not add app.disableHardwareAcceleration() here. With the GPU off,
// Chromium stops painting once the window is reparented into the Windows
// taskbar, and the widget silently disappears. Verified on Windows 11 26200.

const USAGE_PAGE = 'https://claude.ai/new#settings/usage';
const POLL_INTERVAL = 5 * 60 * 1000;
const TICK_INTERVAL = 30 * 1000;   // keeps the reset countdown honest between polls

// The status block reads local files and carries a live seconds clock, so it
// needs its own faster beat. The key is a real meter key like any other, so it
// sits in the same picker and the same visibleMeters list.
const STATUS_KEY = 'claude_status';
const STATUS_INTERVAL = 1000;
const ANIM_INTERVAL = Math.round(1000 / CRAB_FPS);

if (process.platform === 'win32') app.setAppUserModelId('com.harlanecastro.claudeusagebar');

const GAP = 8; // breathing room between the panel, the taskbar and the screen edge

let widget = null;
let settingsWindow = null;
let panelWindow = null;
let pollTimer = null;
let tickTimer = null;
let statusTimer = null;
let animFrame = 0;

// The session the user cycled to, by id. Null means "whichever matters most",
// which is the resting behaviour. Held by id rather than by index because the
// running order re-sorts as states change, and an index would drift onto a
// different session under the user's eyes.
let pinnedSession = null;

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

/** A meter's human name. Scoped limits take theirs from the API's model name. */
function meterLabel(t, meter, reached) {
  switch (meter.kind) {
    case 'session':
      return t.t(reached ? 'widget.sessionLimitReached' : 'widget.sessionUsage');
    case 'weekly_all':
      return t.t(reached ? 'widget.weeklyLimitReached' : 'widget.weeklyUsage');
    case 'weekly_scoped':
      return t.t(reached ? 'widget.weeklyModelLimitReached' : 'widget.weeklyModelUsage',
        { model: meter.model ?? '' });
    default:
      // A meter kind we have never seen. Show whatever the API called it rather
      // than hiding it: an unknown limit is still a limit the user can hit.
      return meter.model ?? meter.kind;
  }
}

/** The meters the user chose, in the order claude.ai returned them. */
function selectedMeters() {
  const chosen = getSettings().visibleMeters;
  const available = model.data ?? [];
  const picked = available.filter((m) => chosen.includes(m.key));
  // Never end up with nothing: a stored selection can name meters this account
  // no longer has (plan change, model retired).
  if (picked.length) return picked;
  return chosen.includes(STATUS_KEY) ? [] : available.slice(0, 1);
}

/** The meters deliberately kept out of the bar — what the panel is for. */
function hiddenMeters() {
  const chosen = getSettings().visibleMeters;
  const shown = new Set(selectedMeters().map((m) => m.key));
  return (model.data ?? []).filter((m) => !shown.has(m.key) && !chosen.includes(m.key));
}

/** "1m 3s" / "43s" — Claude Code's own elapsed-clock style. */
function elapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Which session the status block is showing, and how many there are.
 *
 * A pin only survives while its session is still active — once it finishes, the
 * widget falls back to whatever matters most, so it never strands you watching a
 * dead session while another one waits for an answer.
 */
function shownSession() {
  const sessions = activeSessions();
  if (!sessions.length) {
    pinnedSession = null;
    return { session: null, sessions };
  }

  const pinned = pinnedSession && sessions.find((s) => s.id === pinnedSession);
  if (!pinned) pinnedSession = null;

  return { session: pinned || sessions[0], sessions };
}

/** Move the status block to the next session, wrapping around. */
function cycleSession() {
  const { session, sessions } = shownSession();
  if (sessions.length < 2 || !session) return;

  const at = sessions.findIndex((s) => s.id === session.id);
  pinnedSession = sessions[(at + 1) % sessions.length].id;
  paint();
}

/**
 * The status block: what Claude Code is doing right now.
 *
 * Returns null when nothing is worth saying, so an idle Claude takes no room in
 * the bar rather than parking on a permanent "idle".
 */
function statusBlock(t) {
  const { session, sessions } = shownSession();

  // Nothing running. Say so plainly: the block is switched on, so it owes an
  // answer, and silence would read as a broken widget.
  if (!session) {
    return {
      kind: 'status',
      label: t.t('status.idle'),
      sub: t.t('status.idleHint'),
      tone: null,
      animate: false,
      elapsed: null,
      count: 0,
    };
  }

  // Only worth showing when there is something to cycle through.
  const count = sessions.length > 1 ? sessions.length : 0;

  if (session.state === 'permission') {
    return {
      kind: 'status',
      label: t.t('status.permission'),
      sub: session.project,
      // Amber and still. A spinner would say "busy"; this is the opposite —
      // nothing moves until you act, and that is the whole point of the state.
      tone: 'amber',
      animate: false,
      elapsed: null,
      count,
    };
  }

  const label = session.state === 'tool'
    ? (t.t(`status.tools.${session.tool}`) === `status.tools.${session.tool}`
      ? t.t('status.tools.default')
      : t.t(`status.tools.${session.tool}`))
    : t.t('status.thinking');

  return {
    kind: 'status',
    label,
    sub: session.project,
    tone: null,
    animate: true,
    frame: animFrame,
    elapsed: session.startedAt > 0
      ? elapsed(Math.max(0, Math.floor(Date.now() / 1000) - session.startedAt))
      : null,
    count,
  };
}

function buildView() {
  const settings = getSettings();
  const t = translator();
  const base = { platform: process.platform, dark: nativeTheme.shouldUseDarkColors };

  const notice = (label, sub) => ({ ...base, blocks: [{ label, pct: null, sub, zone: 'ok' }] });

  if (model.state === 'loading') return notice(t.t('widget.loading'), null);
  if (model.state === 'signedOut') return notice(t.t('widget.notSignedIn'), t.t('widget.clickToSignIn'));
  if (model.state === 'error') return notice(t.t('widget.loadFailed'), t.t('widget.clickToRetry'));

  const blocks = selectedMeters().map((meter) => ({
    label: meterLabel(t, meter, meter.utilization >= 100),
    pct: Math.min(100, meter.utilization),
    zone: zoneOf(meter.utilization, settings.thresholds),
    sub: t.t('widget.resetsIn', { duration: t.duration(meter.resetsAt - Date.now()) }),
  }));

  // Status leads: it is the only block that changes second to second, and the
  // one you look for when Claude is waiting on you.
  if (settings.visibleMeters.includes(STATUS_KEY)) {
    const status = statusBlock(t);
    if (status) blocks.unshift(status);
  }

  if (!blocks.length) return notice(t.t('status.idle'), null);

  return { ...base, blocks };
}

/**
 * What the panel shows: only the meters kept out of the bar.
 *
 * Deliberately not "everything" — the panel exists to reach what you chose to
 * hide, so with nothing hidden there is nothing to open.
 */
function buildPanelView() {
  const settings = getSettings();
  const t = translator();

  const blocks = hiddenMeters().map((meter) => ({
    label: meterLabel(t, meter, meter.utilization >= 100),
    pct: Math.min(100, meter.utilization),
    zone: zoneOf(meter.utilization, settings.thresholds),
    sub: t.t('widget.resetsIn', { duration: t.duration(meter.resetsAt - Date.now()) }),
  }));

  if (!settings.visibleMeters.includes(STATUS_KEY)) {
    const status = statusBlock(t);
    if (status) blocks.unshift(status);
  }

  return { blocks };
}

function paint() {
  if (widget) widget.setView(buildView());
  // The panel shows live values too, so it follows every repaint while open.
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('panel:state', buildPanelView());
  }
}

/**
 * Opens the panel under the widget. Does nothing when nothing is hidden: an
 * empty panel would be a worse answer than no panel.
 */
function togglePanel() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.close();
    return;
  }
  if (!buildPanelView().blocks.length) return;

  panelWindow = new BrowserWindow({
    width: 280,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  panelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'panel', 'panel.html'));
  panelWindow.once('ready-to-show', () => {
    panelWindow.webContents.send('panel:state', buildPanelView());
  });
  // Click away and it goes, like any popover.
  panelWindow.on('blur', () => panelWindow && !panelWindow.isDestroyed() && panelWindow.close());
  panelWindow.on('closed', () => { panelWindow = null; });
}

/** Sizes the panel to its content and parks it just clear of the widget. */
function placePanel({ width, height }) {
  if (!panelWindow || panelWindow.isDestroyed()) return;

  const w = Math.max(220, width);
  const h = Math.max(60, height);
  panelWindow.setContentSize(w, h);

  const anchor = widget.anchorRect();
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  const area = display.workArea;

  // Above the taskbar and left-aligned with the widget, then pulled back inside
  // the work area so it can never hang off the edge of the screen.
  const x = Math.min(Math.max(anchor.x, area.x + GAP), area.x + area.width - w - GAP);
  const y = Math.max(area.y + GAP, anchor.y - h - GAP);

  panelWindow.setPosition(Math.round(x), Math.round(y));
  panelWindow.showInactive();
  panelWindow.focus(); // focused so that clicking away blurs it shut
}

async function refresh() {
  if (!auth.isSignedIn()) {
    model.state = 'signedOut';
    return paint();
  }
  try {
    model.data = await fetchUsage();
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
  armStatusTimer();
}

/**
 * The status block beats to its own clock, and re-arms itself each time because
 * the right cadence depends on what Claude is doing.
 *
 * Animating costs a full render and screen capture per frame, so it only runs at
 * that rate while there is something to animate. A permission prompt is
 * deliberately still, and an idle Claude only needs the once-a-second check that
 * notices work starting.
 */
function armStatusTimer() {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;

  if (!getSettings().visibleMeters.includes(STATUS_KEY)) return;

  const { session } = shownSession();
  const animating = !!session && session.state !== 'permission';

  statusTimer = setTimeout(() => {
    if (animating) animFrame = (animFrame + 1) % CRAB_FRAMES.length;
    paint();
    armStatusTimer();
  }, animating ? ANIM_INTERVAL : STATUS_INTERVAL);
}

// ---------- interactions ----------

async function handleClick(button, point) {
  if (button === 'right') return widget.popUpMenu(buildMenu());

  // The session-count badge is a control in its own right; a click that lands on
  // it moves to the next session instead of opening the panel.
  if (widget.hitAt(point) === 'cycle') return cycleSession();

  if (model.state === 'signedOut') return startSignIn();
  if (model.state === 'error') return refresh();
  togglePanel();
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

/**
 * Turn a meter on or off, honouring the same rule the settings window does: the
 * last one selected cannot be turned off, or the strip would have nothing to
 * draw and the only way back is through the widget itself.
 */
function toggleMeter(key) {
  const chosen = getSettings().visibleMeters;
  const next = chosen.includes(key)
    ? chosen.filter((k) => k !== key)
    : [...chosen, key];
  if (!next.length) return;

  setSettings({ visibleMeters: next });
  paint();
  armStatusTimer(); // the status block may have just been switched on or off
  // The settings window may be open on the same setting — keep it honest.
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:changed');
  }
}

function buildMenu() {
  const t = translator();
  const settings = getSettings();
  const signedIn = auth.isSignedIn();

  const items = [];

  if (model.state === 'ok') {
    // The reading first, so the menu answers the question before you pick anything.
    for (const block of buildView().blocks) {
      items.push({ label: `${block.label} ${Math.round(block.pct)}%`, enabled: false });
      items.push({ label: block.sub, enabled: false });
    }
    items.push({ type: 'separator' });
  }

  const meters = availableMeters();
  if (meters.length) {
    items.push({
      label: t.t('settings.meters'),
      submenu: meters.map((meter) => {
        const on = settings.visibleMeters.includes(meter.key);
        return {
          label: meter.label,
          type: 'checkbox',
          checked: on,
          // Greyed out rather than hidden: it explains the rule by showing the
          // one item that cannot be turned off.
          enabled: !(on && settings.visibleMeters.length === 1),
          click: () => toggleMeter(meter.key),
        };
      }),
    });
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
ipcMain.on('panel:rendered', (_e, size) => placePanel(size));

/**
 * What the settings window and the context menu offer to toggle: whatever this
 * account actually has, plus the local Claude Code status.
 */
function availableMeters() {
  const t = translator();
  return [
    { key: STATUS_KEY, label: t.t('status.name') },
    ...(model.data ?? []).map((meter) => ({
      key: meter.key,
      label: meterLabel(t, meter, false),
    })),
  ];
}

/** Only worth offering when there is a choice — see monitors.js. */
function monitorChoices() {
  const monitors = hostMonitors();
  return monitors.length > 1 ? monitors.map(({ id, label, primary }) => ({ id, label, primary })) : [];
}

ipcMain.handle('settings:get', () => ({
  settings: getSettings(),
  languages: availableLanguages(),
  meters: availableMeters(),
  monitors: monitorChoices(),
  strings: translator().dict,
  signedIn: auth.isSignedIn(),
  resolvedLanguage: resolveLanguage(getSettings().language),
}));

ipcMain.handle('settings:set', async (_e, patch) => {
  const after = setSettings(patch);
  // Moving monitors or flipping alignment means the strip has to be rebuilt
  // against a different taskbar; a repaint alone would leave it where it was.
  if (patch.monitorId !== undefined || patch.alignLeft !== undefined) widget.retarget();
  paint();
  armStatusTimer();
  return {
    settings: after,
    meters: availableMeters(),
    monitors: monitorChoices(),
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
  // Launching again while already running must NOT open settings. The installer's
  // finish screen launches the app, so a first-time user landed in a settings
  // window instead of the widget asking them to sign in. There is nothing to open
  // anyway — the widget is the app, and it is already in the taskbar — so just
  // make sure it really is there.
  app.on('second-instance', () => {
    if (widget) widget.retarget();
  });

  app.whenReady().then(async () => {
    auth.applyUserAgent();
    if (IS_MAC && app.dock) app.dock.hide();

    widget = new Widget({
      onClick: handleClick,
      // Read fresh on every call: the monitor and alignment can change under the
      // strip while it runs, and so can the taskbar's hwnd.
      resolveTarget: () => {
        const { monitorId, alignLeft } = getSettings();
        return { hwnd: resolveTaskbar(monitorId), alignLeft };
      },
    });
    widget.create();
    paint();

    await auth.restore();
    await refresh();
    schedulePolling();

    // Prints the context menu as data. The menu only exists while a native popup
    // is up, so this is the only way to check it without a human holding a mouse.
    if (process.argv.includes('--dump-menu')) {
      const describe = (item) => ({
        label: item.label,
        type: item.type,
        checked: item.checked,
        enabled: item.enabled,
        submenu: item.submenu?.items.map(describe),
      });
      console.log('[menu]', JSON.stringify(buildMenu().items.map(describe), null, 1));
    }
  });

  app.on('before-quit', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (statusTimer) clearTimeout(statusTimer);
    if (widget) widget.destroy();
  });

  // The widget is the app: closing the settings window must not end the process.
  app.on('window-all-closed', () => {});
}
