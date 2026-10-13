/**
 * Generate every app icon from one 1024x1024 source.
 *
 *   npm install --no-save sharp
 *   node client/scripts/generate-icons.mjs
 *
 * Source: client/assets/icon.png — square, transparent background, the mark
 * roughly filling the canvas.
 *
 * ── Why the logo is composited onto white rather than left transparent ──
 *
 * Play rejects store icons containing alpha, and a transparent launcher
 * icon renders unpredictably across launchers — sometimes invisible on a
 * dark wallpaper. Every output here is therefore flattened onto white,
 * which also matches the store listing.
 *
 * ── Why the adaptive foreground is scaled to 66% ────────────────────────
 *
 * Android 8+ masks adaptive icons into whatever shape the launcher wants —
 * circle, squircle, teardrop. Only the inner 72dp of the 108dp canvas is
 * guaranteed visible, so a full-bleed logo loses its corners. This logo is
 * a triangle, which is exactly the shape that suffers: its points would be
 * clipped. SAFE_SCALE keeps it inside the guaranteed area.
 */
import sharp from 'sharp';
import { mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..');
const SRC = join(CLIENT, 'assets', 'icon.png');
const RES = join(CLIENT, 'android', 'app', 'src', 'main', 'res');
const PUBLIC = join(CLIENT, 'public');

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/** Fraction of the canvas the mark occupies. */
const FULL_SCALE = 0.86;   // legacy icons — a little breathing room
const SAFE_SCALE = 0.62;   // adaptive/maskable — must survive a circular mask

async function ensure(dir) { await mkdir(dir, { recursive: true }); }

/** The mark, centred on a canvas of `size`, at `scale`, over `bg`. */
async function render(size, scale, bg, out) {
  const inner = Math.round(size * scale);
  const mark = await sharp(SRC)
    .resize(inner, inner, { fit: 'contain', background: CLEAR })
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toFile(out);
  return out;
}

/** Same, then clipped to a circle — for ic_launcher_round. */
async function renderRound(size, scale, out) {
  const square = await sharp({ create: { width: size, height: size, channels: 4, background: WHITE } })
    .composite([{
      input: await sharp(SRC)
        .resize(Math.round(size * scale), Math.round(size * scale), { fit: 'contain', background: CLEAR })
        .toBuffer(),
      gravity: 'centre',
    }])
    .png()
    .toBuffer();

  const circle = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  await sharp(square)
    .composite([{ input: circle, blend: 'dest-in' }])
    .png()
    .toFile(out);
  return out;
}

// Launcher icon is 48dp; the adaptive foreground canvas is 108dp.
const DENSITIES = [
  { dir: 'mipmap-mdpi',    legacy: 48,  adaptive: 108 },
  { dir: 'mipmap-hdpi',    legacy: 72,  adaptive: 162 },
  { dir: 'mipmap-xhdpi',   legacy: 96,  adaptive: 216 },
  { dir: 'mipmap-xxhdpi',  legacy: 144, adaptive: 324 },
  { dir: 'mipmap-xxxhdpi', legacy: 192, adaptive: 432 },
];

try {
  await access(SRC);
} catch {
  console.error(`Source icon not found: ${SRC}\nPut a 1024x1024 PNG there and re-run.`);
  process.exit(1);
}

const { width, height } = await sharp(SRC).metadata();
if (width !== height) console.warn(`! Source is ${width}x${height}, not square — output will be letterboxed.`);
if (width < 512) console.warn(`! Source is only ${width}px — icons will look soft. 1024 is recommended.`);

console.log('Android launcher icons');
for (const d of DENSITIES) {
  const dir = join(RES, d.dir);
  await ensure(dir);
  await render(d.legacy, FULL_SCALE, WHITE, join(dir, 'ic_launcher.png'));
  await renderRound(d.legacy, FULL_SCALE, join(dir, 'ic_launcher_round.png'));
  // Foreground stays transparent: the <background> in the adaptive-icon XML
  // supplies the colour, and baking one in here would show as a square
  // behind the mask on some launchers.
  await render(d.adaptive, SAFE_SCALE, CLEAR, join(dir, 'ic_launcher_foreground.png'));
  console.log(`  ${d.dir.padEnd(16)} ${d.legacy}px legacy + round, ${d.adaptive}px foreground`);
}

console.log('Web / PWA icons');
await ensure(PUBLIC);
await render(192, FULL_SCALE, WHITE, join(PUBLIC, 'pwa-192x192.png'));
await render(512, FULL_SCALE, WHITE, join(PUBLIC, 'pwa-512x512.png'));
// "maskable" means the OS may crop it to any shape — same safe zone rule.
await render(512, SAFE_SCALE, WHITE, join(PUBLIC, 'maskable-icon-512x512.png'));
// iOS ignores alpha and composites on black, so this one must be flattened.
await render(180, FULL_SCALE, WHITE, join(PUBLIC, 'apple-touch-icon.png'));
console.log('  pwa-192, pwa-512, maskable-512, apple-touch-icon');

console.log('In-app logo');
// Transparent, unlike every icon above: this one sits on cards and headers
// in both light and dark themes, so a white plate would show as a box.
// 256px covers the largest use (w-14 = 56px) at 3x device pixel ratio.
await sharp(SRC).resize(256, 256, { fit: 'contain', background: CLEAR }).png().toFile(join(PUBLIC, 'logo.png'));
await sharp(SRC).resize(64, 64, { fit: 'contain', background: CLEAR }).png().toFile(join(PUBLIC, 'favicon.png'));
console.log('  logo.png (256), favicon.png (64)');

console.log('Play Store listing icon');
// Play requires exactly 512x512, 32-bit PNG, and rejects any alpha channel.
await sharp(await render(512, FULL_SCALE, WHITE, join(CLIENT, 'assets', '.tmp-store.png')))
  .removeAlpha()
  .png()
  .toFile(join(CLIENT, 'assets', 'play-store-icon-512.png'));
console.log('  client/assets/play-store-icon-512.png  (upload under Store listing)');

console.log('\nDone. Next: npx cap sync android && cd android && ./gradlew bundleRelease');
