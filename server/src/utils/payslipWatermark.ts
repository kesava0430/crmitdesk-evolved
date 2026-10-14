/**
 * Payslip template watermark options: limits, clamping and resolution.
 *
 * Kept apart from payslipRender.ts so the API schema (controller) and both
 * renderers share one definition of "valid", and so it can be unit-tested
 * without PDFKit. Values are CLAMPED rather than rejected: a slider that
 * overshoots, or an older client sending 0.5, should save the nearest allowed
 * value instead of failing the whole template save.
 */
import { z } from 'zod';

export const WATERMARK_LIMITS = {
  opacity: { min: 0.03, max: 0.3, default: 0.08 },
  size: { min: 20, max: 90, default: 55 },
  rotation: { min: -45, max: 45, default: 0 },
} as const;
export const WATERMARK_SOURCES = ['LOGO', 'IMAGE'] as const;
export type WatermarkSource = typeof WATERMARK_SOURCES[number];

/** Template image fields accept a URL or an uploaded (client-resized) data URL. */
export const IMAGE_URL_MAX_CHARS = 600_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number) => {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : fallback;
};

export const clampOpacity = (v: unknown) => Math.round(clamp(num(v, WATERMARK_LIMITS.opacity.default), WATERMARK_LIMITS.opacity.min, WATERMARK_LIMITS.opacity.max) * 100) / 100;
export const clampSize = (v: unknown) => Math.round(clamp(num(v, WATERMARK_LIMITS.size.default), WATERMARK_LIMITS.size.min, WATERMARK_LIMITS.size.max));
export const clampRotation = (v: unknown) => Math.round(clamp(num(v, WATERMARK_LIMITS.rotation.default), WATERMARK_LIMITS.rotation.min, WATERMARK_LIMITS.rotation.max));

/**
 * Logo / signature / watermark image: an http(s) URL (existing templates may
 * hold plain http links, which still work in the HTML view) or a base64 image
 * data URL produced by the editor's upload button.
 */
export const imageUrlSchema = z.string().max(IMAGE_URL_MAX_CHARS, 'Image is too large — upload a smaller one (max ~450 KB)').refine(
  v => /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(v) || (/^https?:\/\//i.test(v) && z.string().url().safeParse(v).success),
  'Must be an https:// link or an uploaded PNG/JPEG image',
);

const numberish = z.union([z.number(), z.string()]);
/** Zod fields merged into the template schema. Non-numeric input is rejected; out-of-range numbers are clamped. */
export const watermarkSchemaFields = {
  watermarkEnabled: z.boolean().default(false),
  watermarkSource: z.enum(WATERMARK_SOURCES).default('LOGO'),
  watermarkOpacity: numberish.refine(v => Number.isFinite(Number(v)), 'Must be a number').transform(clampOpacity).default(WATERMARK_LIMITS.opacity.default),
  watermarkSize: numberish.refine(v => Number.isFinite(Number(v)), 'Must be a number').transform(clampSize).default(WATERMARK_LIMITS.size.default),
  watermarkRotation: numberish.refine(v => Number.isFinite(Number(v)), 'Must be a number').transform(clampRotation).default(WATERMARK_LIMITS.rotation.default),
  watermarkRepeat: z.boolean().default(false),
};

export interface Watermark { url: string; opacity: number; size: number; rotation: number; repeat: boolean }

/**
 * The effective watermark for a template, or null when it's off or has no
 * image to show (source LOGO with no logo, IMAGE with no upload). Clamps
 * again defensively — rows written before validation existed, or by SQL.
 */
export function resolveWatermark(t: any): Watermark | null {
  if (!t?.watermarkEnabled) return null;
  const url = (t.watermarkSource === 'IMAGE' ? t.watermarkImageUrl : t.logoUrl) || null;
  if (!url) return null;
  return { url, opacity: clampOpacity(t.watermarkOpacity), size: clampSize(t.watermarkSize), rotation: clampRotation(t.watermarkRotation), repeat: !!t.watermarkRepeat };
}

/** Tiles are a fraction of the single-mark size so "size" means the same slider in both modes. */
export const TILE_SCALE = 0.4;
/** Gap between tiles, as a multiple of the tile width. */
export const TILE_GAP = 0.6;
