/**
 * Pulls the original full-colour crab out of claude-status-bar's Swift source.
 *
 * The sprite only exists as base64 PNGs inside CrabFrames.swift. This writes them
 * out untouched — 51x36, no resize, no recolour — so an icon can be made from a
 * real source rather than from the alpha masks the widget uses.
 *
 * Run:  npx electron scripts/extract-crab.js [--source=<path to claude-status-bar>]
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SOURCE = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1]
  || 'C:/Projetos/claude-status-bar';
const BUILD = path.join(__dirname, '..', 'build');

app.whenReady().then(() => {
  const swift = fs.readFileSync(path.join(SOURCE, 'Sources', 'CrabFrames.swift'), 'utf8');
  const frames = [...swift.matchAll(/"(iVBORw0KGgo[A-Za-z0-9+/=]+)"/g)].map((m) => m[1]);
  if (!frames.length) {
    console.error('No frames found. Is --source= pointing at claude-status-bar?');
    app.exit(1);
    return;
  }

  const poses = path.join(BUILD, 'crab-frames');
  fs.mkdirSync(poses, { recursive: true });

  // Frame 0 is the resting pose — the one worth turning into an icon.
  fs.writeFileSync(path.join(BUILD, 'crab.png'), Buffer.from(frames[0], 'base64'));
  frames.forEach((f, i) => {
    fs.writeFileSync(path.join(poses, `crab-${String(i).padStart(2, '0')}.png`), Buffer.from(f, 'base64'));
  });

  console.log(`build/crab.png         resting pose`);
  console.log(`build/crab-frames/     all ${frames.length} poses`);
  app.exit(0);
});
