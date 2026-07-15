/**
 * The widget renderer is a dumb painter.
 *
 * Every string arrives translated and pre-formatted from the main process, so
 * the Windows taskbar strip and the macOS menu bar image can never word things
 * differently. All this file decides is layout: two stacked lines on Windows,
 * one inline row on macOS.
 */
const root = document.getElementById('widget');

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const meter = (pct, zone) => {
  const track = el('span', `meter zone-${zone}`);
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  track.appendChild(fill);
  return track;
};

/**
 * Clawd the crab, as a CSS mask rather than an image, so he is painted in the
 * bar's own text colour and adapts to a light or dark taskbar for free.
 *
 * The frame index comes from the main process: this page is captured to a
 * bitmap, so a CSS animation would never reach the taskbar — only what happens
 * to be painted at capture time does.
 *
 * A still frame 0 stands in when there is nothing to animate: a permission
 * prompt is deliberately motionless, since a spinner would say "busy" when the
 * whole point is that nothing moves until you act.
 */
const icon = (block) => {
  const { CRAB_FRAMES } = globalThis.StatusFrames;
  const node = el('span', `icon${block.tone ? ` tone-${block.tone}` : ''}`);
  const src = CRAB_FRAMES[(block.animate ? block.frame : 0) % CRAB_FRAMES.length];
  node.style.webkitMaskImage = `url("${src}")`;
  node.style.maskImage = `url("${src}")`;
  return node;
};

/**
 * How many Claude Code sessions are running. Only drawn when there is more than
 * one, because otherwise the number says nothing you cannot already see.
 *
 * Tagged as a hit target: the main process reads its rect back and routes a
 * click inside it to cycling instead of to the usage page.
 */
const badge = (count) => {
  const node = el('span', 'badge', String(count));
  node.dataset.hit = 'cycle';
  return node;
};

function winBlock(block) {
  const group = el('div', 'group');
  const line1 = el('div', 'line1');

  if (block.kind === 'status') line1.appendChild(icon(block));
  line1.appendChild(el('span', `label${block.tone ? ` tone-${block.tone}` : ''}`, block.label));
  if (block.count) line1.appendChild(badge(block.count));
  if (block.elapsed) line1.appendChild(el('span', 'clock', block.elapsed));
  if (block.pct != null) {
    line1.appendChild(meter(block.pct, block.zone));
    line1.appendChild(el('span', `pct zone-${block.zone}`, `${Math.round(block.pct)}%`));
  }
  group.appendChild(line1);

  if (block.sub) group.appendChild(el('div', 'line2', block.sub));
  return group;
}

function macBlock(block, parts) {
  if (block.kind === 'status') parts.push(icon(block));
  parts.push(el('span', block.tone ? `tone-${block.tone}` : null, block.label));
  if (block.count) parts.push(badge(block.count));
  if (block.elapsed) parts.push(el('span', 'clock', block.elapsed));
  if (block.pct != null) {
    parts.push(el('span', `pct zone-${block.zone}`, `${Math.round(block.pct)}%`));
    parts.push(meter(block.pct, block.zone));
  }
  if (block.sub) {
    parts.push(el('span', 'sep', '·'));
    parts.push(el('span', null, block.sub));
  }
}

function render(view) {
  document.body.className = [
    view.platform === 'darwin' ? 'mac' : 'win',
    view.dark ? 'dark' : 'light',
  ].join(' ');

  root.replaceChildren();

  // Whatever the user chose to show, in the order claude.ai lists them.
  const blocks = view.blocks ?? [];

  if (view.platform === 'darwin') {
    const parts = [];
    blocks.forEach((block, i) => {
      if (i > 0) parts.push(el('span', 'sep', '·'));
      macBlock(block, parts);
    });
    parts.forEach((p) => root.appendChild(p));
  } else {
    blocks.forEach((block, i) => {
      if (i > 0) root.appendChild(el('div', 'divider'));
      root.appendChild(winBlock(block));
    });
  }

  // Report the size synchronously. getBoundingClientRect forces layout, which is
  // all we need — and requestAnimationFrame must not be used here: this window is
  // never shown, and a hidden window produces no frames, so an rAF callback would
  // simply never run and the widget would stay blank forever.
  const r = root.getBoundingClientRect();

  // Hand back where the clickable bits landed. Nothing in this page can receive a
  // click — it is only ever captured to a bitmap — so the main process hit-tests
  // these rects against the coordinates the native window reports.
  const hits = [...root.querySelectorAll('[data-hit]')].map((node) => {
    const box = node.getBoundingClientRect();
    return {
      action: node.dataset.hit,
      x: Math.floor(box.left - r.left),
      y: Math.floor(box.top - r.top),
      width: Math.ceil(box.width),
      height: Math.ceil(box.height),
    };
  });

  window.usageBar.rendered({ width: Math.ceil(r.width), height: Math.ceil(r.height), hits });
}

// No input handling here on purpose: this page is never shown. Clicks arrive at
// the native taskbar window (Windows) or the tray item (macOS) and are handled in
// the main process.
window.usageBar.onState(render);
