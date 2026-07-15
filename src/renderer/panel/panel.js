/**
 * The hidden-meters panel. A dumb painter, like the widget renderer: every
 * string arrives translated and pre-formatted from the main process.
 */
const root = document.getElementById('panel');

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const icon = (block) => {
  const { CRAB_FRAMES } = globalThis.StatusFrames;
  const node = el('span', `icon${block.tone ? ` tone-${block.tone}` : ''}`);
  const src = CRAB_FRAMES[(block.animate ? block.frame : 0) % CRAB_FRAMES.length];
  node.style.webkitMaskImage = `url("${src}")`;
  node.style.maskImage = `url("${src}")`;
  return node;
};

function render(view) {
  root.className = 'panel';
  root.replaceChildren();

  for (const block of view.blocks ?? []) {
    const row = el('div', 'row');
    const head = el('div', 'head');

    if (block.kind === 'status') head.appendChild(icon(block));
    head.appendChild(el('span', `name${block.tone ? ` tone-${block.tone}` : ''}`, block.label));
    if (block.elapsed) head.appendChild(el('span', 'clock', block.elapsed));
    if (block.pct != null) head.appendChild(el('span', `pct zone-${block.zone}`, `${Math.round(block.pct)}%`));
    row.appendChild(head);

    if (block.pct != null) {
      const track = el('span', `meter zone-${block.zone}`);
      const fill = el('i');
      fill.style.width = `${Math.max(0, Math.min(100, block.pct))}%`;
      track.appendChild(fill);
      row.appendChild(track);
    }

    if (block.sub) row.appendChild(el('div', 'sub', block.sub));
    root.appendChild(row);
  }

  // Report the painted size so the window can be sized to fit and placed above
  // the taskbar. Synchronous on purpose: getBoundingClientRect forces layout.
  const r = root.getBoundingClientRect();
  window.usagePanel.rendered({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
}

window.usagePanel.onState(render);
