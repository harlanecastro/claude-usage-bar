/**
 * Generates src/shared/status-frames.js from claude-status-bar's Swift sources.
 *
 * The crab sprite ships as full-colour PNGs, but the widget draws its icon as a
 * CSS mask so it takes the colour of the bar's own text. A mask only reads the
 * alpha channel, so colour has to become opacity first.
 *
 * This is the same mapping claude-status-bar uses to build its macOS template
 * image (Sources/CrabRender.swift, adaptiveCrabFrame): brightness drives alpha,
 * so the bright body stays solid, the darker legs fade to partial ink, and the
 * darkest pixels — eyes and outlines — drop out as holes. Without it, masking a
 * crab whose every pixel is opaque would paint a solid blob.
 *
 * Run:  npx electron scripts/build-crab-frames.js
 * (Electron, not node: it is here for nativeImage's PNG codec.)
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const SOURCE = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1]
  || 'C:/Projetos/claude-status-bar';
const OUT = path.join(__dirname, '..', 'src', 'shared', 'status-frames.js');

// Tuned by eye in the original, and measured off the sprite: eyes/outlines sit at
// luminance <= 0.15, the darker legs around 0.45, the body around 0.57. darkCut
// sits above the eyes so they punch through, and below the legs so they stay
// grey; bodyLevel sits at the body, which goes solid. gamma deepens the legs.
const DARK_CUT = 0.30;
const BODY_LEVEL = 0.54;
const GAMMA = 1.3;

const grabBase64 = (file) => {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/"(iVBORw0KGgo[A-Za-z0-9+/=]+)"/g)].map((m) => m[1]);
};

/** Colour PNG -> alpha-only mask, as a data URI. */
function toMask(base64) {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
  const { width, height } = image.getSize();
  const px = image.getBitmap(); // BGRA, premultiplied

  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const rawA = px[o + 3];
    if (rawA === 0) continue; // background stays transparent

    const af = rawA / 255;
    const b = px[o] / (255 * af);
    const g = px[o + 1] / (255 * af);
    const r = px[o + 2] / (255 * af);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; // the ink itself is irrelevant to a mask

    if (lum < DARK_CUT) {
      px[o + 3] = 0;
    } else {
      const t = Math.min(1, (lum - DARK_CUT) / (BODY_LEVEL - DARK_CUT));
      px[o + 3] = Math.max(0, Math.min(255, Math.round(rawA * Math.pow(t, GAMMA))));
    }
  }

  const out = nativeImage.createFromBuffer(px, { width, height });
  return 'data:image/png;base64,' + out.toPNG().toString('base64');
}

app.whenReady().then(() => {
  const crab = grabBase64(path.join(SOURCE, 'Sources', 'CrabFrames.swift'));
  if (!crab.length) {
    console.error('No frames found. Is --source= pointing at claude-status-bar?');
    app.exit(1);
    return;
  }

  const frames = crab.map(toMask);

  const file = `/**
 * Animation frames for the Claude status icon.
 *
 * Clawd the crab, lifted from claude-status-bar (Sources/CrabFrames.swift) and
 * converted from colour to an alpha-only mask by scripts/build-crab-frames.js —
 * regenerate with that script rather than editing this file.
 *
 * The widget applies these as CSS masks, so the icon is painted in the bar's own
 * text colour and adapts to a light or dark taskbar for free.
 */
const CRAB_FRAMES = [
${frames.map((f) => `  '${f}',`).join('\n')}
];

// Matches the source GIF's 0.08s frame delay.
const CRAB_FPS = 12.5;

// Dual export: required by the main process, and loaded with a plain <script>
// tag by the widget renderer, which is sandboxed and has no require().
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CRAB_FRAMES, CRAB_FPS };
} else {
  globalThis.StatusFrames = { CRAB_FRAMES, CRAB_FPS };
}
`;

  fs.writeFileSync(OUT, file);
  console.log(`Wrote ${frames.length} frames to ${OUT}`);
  app.exit(0);
});
