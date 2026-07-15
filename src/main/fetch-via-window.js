/**
 * Fetches JSON from claude.ai through a hidden BrowserWindow.
 *
 * Claude.ai sits behind Cloudflare, which blocks Node's fetch from Electron on
 * header fingerprint alone. Loading the endpoint in a real browser window with
 * a Chrome User-Agent rides the session cookie past it. Do not "simplify" this
 * back to fetch() without checking that Cloudflare still lets it through.
 */
const { BrowserWindow } = require('electron');

const BLOCKED_SIGNATURES = [
  { pattern: 'Just a moment', error: 'CloudflareBlocked' },
  { pattern: 'Enable JavaScript and cookies to continue', error: 'CloudflareChallenge' },
  { pattern: '<html', error: 'UnexpectedHTML' },
];

function parseBody(text) {
  for (const sig of BLOCKED_SIGNATURES) {
    if (text.includes(sig.pattern)) throw new Error(`${sig.error}: ${text.slice(0, 160)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`InvalidJSON: ${text.slice(0, 160)}`);
  }
}

/** Fetch several URLs in sequence through one reused hidden window. */
function fetchJson(urls, { timeoutMs = 20000 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 600,
      height: 400,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, images: false },
    });

    const results = [];
    let index = 0;
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!win.isDestroyed()) win.destroy();
    };
    const fail = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const done = () => { if (!settled) { settled = true; cleanup(); resolve(Array.isArray(urls) ? results : results[0]); } };

    const loadNext = () => {
      if (index >= list.length) return done();
      timer = setTimeout(() => fail(new Error(`Timeout: ${list[index]}`)), timeoutMs);
      win.loadURL(list[index]);
    };

    win.webContents.on('did-finish-load', async () => {
      if (settled) return;
      if (timer) { clearTimeout(timer); timer = null; }
      try {
        const text = await win.webContents.executeJavaScript(
          'document.body.innerText || document.body.textContent'
        );
        results.push(parseBody(text));
        index++;
        loadNext();
      } catch (err) {
        fail(err);
      }
    });

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      fail(new Error(`LoadFailed(${code}): ${desc}`));
    });

    loadNext();
  });
}

const isAuthError = (err) =>
  /CloudflareBlocked|CloudflareChallenge|UnexpectedHTML|Unauthorized|403|401/i.test(err.message || '');

module.exports = { fetchJson, isAuthError };
