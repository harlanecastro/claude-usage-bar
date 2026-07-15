/**
 * Session handling.
 *
 * We never see a password: the user signs in to claude.ai in a normal browser
 * window and we pick up the sessionKey cookie it leaves behind, then keep it in
 * the OS keychain via safeStorage.
 */
const { BrowserWindow, session, safeStorage } = require('electron');
const { store } = require('./config');
const { fetchJson } = require('./fetch-via-window');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Claude.ai and the identity providers it hands off to. Anything else is a
// phishing risk, so navigation to it is refused outright.
const ALLOWED_LOGIN_HOSTS = [
  'claude.ai',
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
];

function applyUserAgent() {
  session.defaultSession.setUserAgent(CHROME_UA);
}

function getSessionKey() {
  const encrypted = store.get('sessionKey_encrypted');
  if (encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return null; // keychain rejected it (e.g. restored to a different machine)
    }
  }
  return store.get('sessionKey', null);
}

function saveSessionKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    store.set('sessionKey_encrypted', safeStorage.encryptString(key).toString('base64'));
    store.delete('sessionKey');
  } else {
    store.set('sessionKey', key);
  }
}

async function setCookie(key) {
  await session.defaultSession.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: key,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true,
  });
}

async function restore() {
  const key = getSessionKey();
  if (!key) return false;
  await setCookie(key);
  return true;
}

async function signOut() {
  store.delete('sessionKey');
  store.delete('sessionKey_encrypted');
  store.delete('organizationId');
  try {
    const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
    for (const c of cookies) {
      await session.defaultSession.cookies.remove('https://claude.ai', c.name);
    }
    await session.defaultSession.clearStorageData({
      storages: ['localstorage', 'sessionstorage', 'cachestorage'],
      origin: 'https://claude.ai',
    });
  } catch { /* nothing to clear */ }
}

function isSignedIn() {
  return !!getSessionKey() && !!store.get('organizationId');
}

/**
 * Open a real login window and wait for the sessionKey cookie to appear.
 *
 * The login is deliberately not embedded in our own UI: Cloudflare blocks
 * Electron-shaped logins, and asking for the password ourselves would be the
 * wrong thing to do even if it worked.
 */
function openLoginWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1000,
      height: 720,
      title: 'Claude — https://claude.ai/login',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition: undefined },
    });

    let resolved = false;

    win.webContents.on('will-navigate', (event, url) => {
      let host;
      try {
        host = new URL(url).hostname;
      } catch {
        return event.preventDefault();
      }
      const allowed = ALLOWED_LOGIN_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
      if (!allowed) {
        event.preventDefault();
        console.warn('[auth] blocked navigation to', url);
      } else {
        win.setTitle(`Claude — ${url}`);
      }
    });

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('did-navigate', (_e, url) => win.setTitle(`Claude — ${url}`));

    const onCookieChanged = (_event, cookie, _cause, removed) => {
      if (cookie.name !== 'sessionKey' || removed || !cookie.value) return;
      if (!cookie.domain.includes('claude.ai')) return;
      resolved = true;
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!win.isDestroyed()) win.close();
      resolve({ ok: true, sessionKey: cookie.value });
    };

    session.defaultSession.cookies.on('changed', onCookieChanged);

    win.on('closed', () => {
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!resolved) resolve({ ok: false, error: 'cancelled' });
    });

    win.loadURL('https://claude.ai/login');
  });
}

/** Confirm a key works and remember which organization to report on. */
async function resolveOrganization() {
  const orgs = await fetchJson('https://claude.ai/api/organizations');
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('NoOrganizations');

  const chatOrgs = orgs.filter((o) => o.capabilities && o.capabilities.includes('chat'));
  if (chatOrgs.length === 0) throw new Error('NoChatOrganization');

  const chosen = chatOrgs.find((o) => o.raven_type === 'team') || chatOrgs[0];
  const id = chosen.uuid || chosen.id;
  store.set('organizationId', id);
  return id;
}

async function signIn() {
  const result = await openLoginWindow();
  if (!result.ok) return result;

  await setCookie(result.sessionKey);
  try {
    await resolveOrganization();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  saveSessionKey(result.sessionKey);
  return { ok: true };
}

module.exports = {
  applyUserAgent, restore, signIn, signOut, isSignedIn,
  resolveOrganization, getSessionKey, CHROME_UA,
};
