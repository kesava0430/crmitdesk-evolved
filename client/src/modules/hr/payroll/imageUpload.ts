/**
 * Turns a picked image file into a small PNG/JPEG data URL for payslip
 * templates (logo, signature, watermark), so templates need no file-storage
 * service: the image lives in the template row itself.
 *
 *  - Any format the browser can decode (PNG, JPEG, WebP, GIF, SVG…) is
 *    redrawn on a canvas, so the result is always PNG or JPEG — the only
 *    formats the server's PDF renderer can embed.
 *  - Longest side ≤ 800 px; transparent images stay PNG (logos and
 *    signatures need the alpha), opaque ones become JPEG.
 *  - Shrinks until the data URL is under ~400 KB; the API accepts 600 KB.
 */
export const MAX_DATA_URL_CHARS = 400_000;
const MAX_SIDE = 800;
const MIN_SIDE = 160;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file could not be read as an image.')); };
    img.src = url;
  });
}

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) return true; // sampled — plenty for a logo
  return false;
}

export async function fileToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (PNG or JPEG work best).');
  if (file.size > 15 * 1024 * 1024) throw new Error('That image is over 15 MB — choose a smaller one.');
  const img = await loadImage(file);
  // SVGs without intrinsic size report 0 — give them a sensible canvas.
  const iw = img.naturalWidth || 800, ih = img.naturalHeight || 800;
  let side = Math.min(MAX_SIDE, Math.max(iw, ih));
  let alpha: boolean | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const scale = side / Math.max(iw, ih);
    const w = Math.max(1, Math.round(iw * scale)), h = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not process the image.');
    ctx.drawImage(img, 0, 0, w, h);
    if (alpha === null) alpha = hasTransparency(ctx, w, h);
    let out = alpha ? canvas.toDataURL('image/png') : '';
    if (!alpha || (out.length > MAX_DATA_URL_CHARS && side <= MIN_SIDE)) {
      // Opaque (or a transparent image that won't fit as PNG): JPEG on white.
      const flat = document.createElement('canvas'); flat.width = w; flat.height = h;
      const fctx = flat.getContext('2d')!;
      fctx.fillStyle = '#ffffff'; fctx.fillRect(0, 0, w, h); fctx.drawImage(canvas, 0, 0);
      out = flat.toDataURL('image/jpeg', 0.85);
    }
    if (out.length <= MAX_DATA_URL_CHARS) return out;
    side = Math.max(MIN_SIDE, Math.round(side * 0.75));
  }
  throw new Error('Could not make this image small enough — try a simpler image.');
}

export const isDataUrl = (v: string | null | undefined) => !!v && v.startsWith('data:');
/** Approximate decoded size of a base64 data URL, for display. */
export const dataUrlKb = (v: string) => Math.round((v.length - v.indexOf(',') - 1) * 0.75 / 1024);
