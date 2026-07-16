/**
 * Rebuilds the alpha channel of the app icon.
 *
 * The crab is 51x36 in claude-status-bar's Swift source — far too small for an
 * icon — so it gets upscaled by hand. Upscalers tend to hand back a PNG with no
 * alpha at all, flattened onto whatever the editor showed behind it: a light
 * checkerboard, with the eyes (holes in the original) turned solid white.
 *
 * Cutting by colour alone would leave a pale fringe wherever the edges were
 * blended with that background. Chroma is the honest tell instead: the crab is
 * one saturated clay colour, while the background and the eyes are grey
 * (R≈G≈B). Blending with grey scales chroma down in proportion to coverage, so
 * chroma recovers the alpha, and the blend can then be undone to get the
 * original colour back.
 *
 * Run:  npx electron scripts/unmatte-icon.js <flattened.png>
 * Writes build/icon.png, which electron-builder turns into the .ico itself.
 * (Electron, not node: it is here for nativeImage's PNG codec.)
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const IN = process.argv[2] || path.join(__dirname, '..', 'build', 'crab-source.png');
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

// Below this chroma a pixel is grey: background, or an eye.
const GREY = 24;

const chromaOf = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

app.whenReady().then(() => {
  const image = nativeImage.createFromBuffer(fs.readFileSync(IN));
  const { width, height } = image.getSize();
  if (!width) {
    console.error(`Could not read ${IN}`);
    app.exit(1);
    return;
  }

  const px = Buffer.from(image.getBitmap()); // BGRA; getBitmap's own buffer is read-only

  // "Fully covered" is the MOST COMMON chroma, not the highest. The body is a
  // flat colour, so its chroma dominates the histogram, whereas the peak is an
  // upscaling overshoot on some edge — taking the peak left the entire body at
  // alpha 215 and dragged the colour off with it.
  const histogram = new Uint32Array(256);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    histogram[chromaOf(px[o + 2], px[o + 1], px[o])]++;
  }
  let full = GREY;
  for (let c = GREY; c < 256; c++) if (histogram[c] > histogram[full]) full = c;

  // Whatever it was flattened against, read from a corner.
  const bg = { b: px[0], g: px[1], r: px[2] };

  let solid = 0; let clear = 0; let edge = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const alpha = Math.min(1, chromaOf(px[o + 2], px[o + 1], px[o]) / full);

    if (alpha <= 0.05) {
      px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
      clear++;
      continue;
    }

    // observed = crab*alpha + bg*(1 - alpha), solved for crab.
    const undo = (v, back) => Math.max(0, Math.min(255, Math.round((v - back * (1 - alpha)) / alpha)));
    px[o] = undo(px[o], bg.b);
    px[o + 1] = undo(px[o + 1], bg.g);
    px[o + 2] = undo(px[o + 2], bg.r);
    px[o + 3] = Math.round(alpha * 255);
    if (alpha >= 0.99) solid++; else edge++;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, nativeImage.createFromBuffer(px, { width, height }).toPNG());

  console.log(`background     #${bg.r.toString(16)}${bg.g.toString(16)}${bg.b.toString(16)}`);
  console.log(`body chroma    ${full} (most common)`);
  console.log(`solid ${solid}  transparent ${clear}  edge ${edge}`);
  console.log(`wrote          ${OUT}  ${width}x${height}`);
  app.exit(0);
});
