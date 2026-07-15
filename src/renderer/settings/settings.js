const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  strings: null,
  meters: [],
};

const lookup = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), state.strings);

function applyStrings() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const value = lookup(node.dataset.i18n);
    if (typeof value === 'string') node.textContent = value;
  }
  document.title = lookup('settings.windowTitle') || 'Settings';
  renderZones();
  renderMeters();
  renderAuth();
}

// ---------- thresholds ----------

const clampWarn = (v) => Math.min(Math.max(v, 5), state.settings.thresholds.crit - 5);
const clampCrit = (v) => Math.min(Math.max(v, state.settings.thresholds.warn + 5), 95);

function renderZones() {
  const { warn, crit } = state.settings.thresholds;

  $('z1').style.width = `${warn}%`;
  $('z2').style.width = `${crit - warn}%`;
  $('z3').style.width = `${100 - crit}%`;

  $('h1').style.left = `${warn}%`;
  $('h2').style.left = `${crit}%`;
  $('h1').setAttribute('aria-valuenow', warn);
  $('h2').setAttribute('aria-valuenow', crit);
  $('h1').setAttribute('aria-label', lookup('settings.yellow') || 'yellow');
  $('h2').setAttribute('aria-label', lookup('settings.red') || 'red');

  $('b1').style.left = `${warn}%`;
  $('b2').style.left = `${crit}%`;
  $('b1').textContent = `${warn}%`;
  $('b2').textContent = `${crit}%`;

  $('lg1').textContent = `0% – ${warn}% · ${lookup('settings.greenHint') || ''}`;
  $('lg2').textContent = `${warn}% – ${crit}% · ${lookup('settings.yellowHint') || ''}`;
  $('lg3').textContent = `${crit}% – 100% · ${lookup('settings.redHint') || ''}`;
}

let dragging = null;

const pctFromX = (clientX) => {
  const r = $('zoneTrack').getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 100);
};

function commitThresholds() {
  push({ thresholds: state.settings.thresholds });
}

for (const id of ['h1', 'h2']) {
  $(id).addEventListener('pointerdown', (event) => {
    dragging = id;
    $(id).setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  $(id).addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 10 : 1;
    let delta = 0;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') delta = -step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') delta = step;
    else return;
    event.preventDefault();

    const t = state.settings.thresholds;
    if (id === 'h1') t.warn = clampWarn(t.warn + delta);
    else t.crit = clampCrit(t.crit + delta);
    renderZones();
    commitThresholds();
  });
}

window.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const value = pctFromX(event.clientX);
  const t = state.settings.thresholds;
  if (dragging === 'h1') t.warn = clampWarn(value);
  else t.crit = clampCrit(value);
  renderZones();
});

// Persist on release rather than on every pointermove: dragging fires dozens of
// events and each one would repaint the widget and hit the store.
window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = null;
  commitThresholds();
});

// ---------- toggles, language, account ----------

function bindSwitch(id, key) {
  $(id).addEventListener('click', () => {
    const next = !state.settings[key];
    $(id).setAttribute('aria-checked', String(next));
    push({ [key]: next });
  });
}

bindSwitch('startAtLogin', 'startAtLogin');

// ---------- meters ----------

function renderMeters() {
  const host = $('meters');
  host.replaceChildren();

  if (!state.meters.length) {
    const empty = document.createElement('p');
    empty.className = 'meters-empty';
    empty.textContent = lookup('settings.metersLoading') || '';
    host.appendChild(empty);
    return;
  }

  const chosen = state.settings.visibleMeters;

  for (const meter of state.meters) {
    const on = chosen.includes(meter.key);
    // The only one left on has to stay on: with none selected the widget would
    // have nothing to draw and no way back other than this window.
    const locked = on && chosen.length === 1;

    const row = document.createElement('button');
    row.className = 'meter';
    row.type = 'button';
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', String(on));
    if (locked) {
      row.dataset.locked = 'true';
      row.setAttribute('aria-disabled', 'true');
    }

    const box = document.createElement('span');
    box.className = 'box';
    const label = document.createElement('span');
    label.textContent = meter.label;
    row.append(box, label);

    row.addEventListener('click', () => {
      if (locked) return;
      const next = on
        ? chosen.filter((k) => k !== meter.key)
        : [...chosen, meter.key];
      push({ visibleMeters: next });
    });

    host.appendChild(row);
  }
}

$('lang').addEventListener('change', (event) => push({ language: event.target.value }));

$('authBtn').addEventListener('click', async () => {
  const signedIn = state.signedIn
    ? await window.settingsApi.signOut()
    : await window.settingsApi.signIn();
  state.signedIn = signedIn;
  renderAuth();
});

function renderAuth() {
  $('authStatus').textContent = lookup(state.signedIn ? 'settings.signedInAs' : 'settings.signedOut') || '';
  $('authBtn').textContent = lookup(state.signedIn ? 'settings.signOut' : 'settings.signIn') || '';
}

async function push(patch) {
  Object.assign(state.settings, patch);
  const result = await window.settingsApi.set(patch);
  state.settings = result.settings;
  state.strings = result.strings;
  state.meters = result.meters ?? state.meters;
  applyStrings();
  syncControls();
}

function syncControls() {
  $('startAtLogin').setAttribute('aria-checked', String(state.settings.startAtLogin));
  $('lang').value = state.settings.language;
  renderMeters();
}

// ---------- boot ----------

(async function init() {
  const data = await window.settingsApi.get();
  state.settings = data.settings;
  state.strings = data.strings;
  state.meters = data.meters ?? [];
  state.signedIn = data.signedIn;

  const select = $('lang');
  // "Auto" is labelled in the language it would resolve to, so the option reads
  // naturally whatever the user is currently seeing.
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = `${data.languages.find((l) => l.key === data.resolvedLanguage)?.label ?? 'English'} — auto`;
  select.appendChild(auto);

  for (const lang of data.languages) {
    const option = document.createElement('option');
    option.value = lang.key;
    option.textContent = lang.label;
    select.appendChild(option);
  }

  applyStrings();
  syncControls();
})();

window.settingsApi.onAuth((signedIn) => {
  state.signedIn = signedIn;
  renderAuth();
});
