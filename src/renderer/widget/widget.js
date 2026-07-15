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

function winBlock(block) {
  const group = el('div', 'group');
  const line1 = el('div', 'line1');

  line1.appendChild(el('span', 'label', block.label));
  if (block.pct != null) {
    line1.appendChild(meter(block.pct, block.zone));
    line1.appendChild(el('span', `pct zone-${block.zone}`, `${Math.round(block.pct)}%`));
  }
  group.appendChild(line1);

  if (block.sub) group.appendChild(el('div', 'line2', block.sub));
  return group;
}

function macBlock(block, parts) {
  parts.push(el('span', null, block.label));
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

  const blocks = [view.weekly, view.monthly].filter(Boolean);

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

  // Report the painted size so the host can size the taskbar slot (Windows) or
  // the captured tray image (macOS). Wait for layout, then for paint.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const r = root.getBoundingClientRect();
    window.usageBar.rendered({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
  }));
}

root.addEventListener('mouseenter', () => root.classList.add('hover'));
root.addEventListener('mouseleave', () => root.classList.remove('hover'));

root.addEventListener('mousedown', (event) => {
  event.preventDefault();
  if (event.button === 0) window.usageBar.click('left');
  else if (event.button === 2) window.usageBar.click('right');
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

window.usageBar.onState(render);
