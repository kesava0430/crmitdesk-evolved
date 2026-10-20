// ─── Server-side face analysis (face-api on TensorFlow.js WASM) ──────────────
//
// Why the server looks at pixels at all: the original design trusted a
// 128-float descriptor computed in the browser, so anyone could POST a
// descriptor made offline from a photo and never open a camera. Liveness
// frames are only worth something if the server itself finds the face,
// the landmarks and the descriptor in them.
//
// Why this stack: the EC2 deploy runs a plain `npm ci` on a t3.small, so
// nothing native (tfjs-node, node-canvas, sharp, onnxruntime-node) — face-api's
// own Node WASM build on @tensorflow/tfjs-backend-wasm, JPEGs decoded by the
// pure-JS jpeg-js. The model weights are the very files the browser loads
// (client/public/models/face is a copy of the package's model/ folder), read
// from node_modules so the server needs nothing from the client build.
//
// Cost (measured on the 2-vCPU dev box): ~0.3 s to load the backend + models
// once, ~140 MB RSS after load, and roughly 60–120 ms CPU per 320 px frame —
// see the report in the commit that added this file. One analysis runs at a
// time (the WASM backend is single-threaded anyway, and a 2-vCPU box should
// keep a core for the API); a short queue absorbs the morning check-in rush
// and anything beyond it gets a "busy, try again" instead of piling up.

import fs from 'fs';
import path from 'path';
import { AppError } from '../../middleware/errorHandler';
import { faceGeometry, type FaceGeometry, type Pt } from './metrics';
import { toGrey, type GreyImage } from './planarity';

/** Frames bigger than this are refused rather than decoded — the client sends ~320 px. */
export const MAX_FRAME_EDGE = 640;
const MAX_QUEUE = Number(process.env.FACE_ENGINE_MAX_QUEUE || 24);

export interface FrameAnalysis {
  faces: number;
  width: number;
  height: number;
  /** Present when exactly one face was found. */
  geometry?: FaceGeometry;
  descriptor?: number[];
  score?: number;
  box?: { x: number; y: number; width: number; height: number };
  /** Grey 16×16 thumbnail, used to spot byte-identical/static replays cheaply. */
  thumb: Float32Array;
  /** Full-size luma and the 68 landmarks, for the planar-motion test. */
  grey: GreyImage;
  landmarks?: Pt[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FaceApi = any;
let enginePromise: Promise<FaceApi> | null = null;

function modelDir(): string {
  const candidates = [
    process.env.FACE_MODEL_DIR,
    (() => { try { return path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model'); } catch { return undefined; } })(),
    path.join(__dirname, '../../../../client/dist/models/face'),
    path.join(__dirname, '../../../../client/public/models/face'),
  ].filter((p): p is string => !!p);
  const found = candidates.find(p => fs.existsSync(path.join(p, 'tiny_face_detector_model-weights_manifest.json')));
  if (!found) throw new Error(`Face model weights not found (looked in: ${candidates.join(', ')})`);
  return found;
}

/** Loads TF.js WASM + the three nets once per process. */
export function loadEngine(): Promise<FaceApi> {
  if (!enginePromise) {
    enginePromise = (async () => {
      // Required lazily: the import alone pulls in TF.js, which processes that
      // never verify a face (workers, scripts, unit tests) shouldn't pay for.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
      await faceapi.tf.setBackend('wasm');
      await faceapi.tf.ready();
      const dir = modelDir();
      await faceapi.nets.tinyFaceDetector.loadFromDisk(dir);
      await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(dir);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
      return faceapi;
    })().catch(err => { enginePromise = null; throw err; });
  }
  return enginePromise;
}

// ── Concurrency: one analysis at a time, bounded queue ──
let running = false;
const waiting: Array<() => void> = [];

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (running) {
    if (waiting.length >= MAX_QUEUE) {
      const err = new AppError(503, 'Face verification is busy right now — please try again in a few seconds.');
      (err as any).code = 'FACE_ENGINE_BUSY';
      throw err;
    }
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  running = true;
  try { return await fn(); }
  finally {
    const next = waiting.shift();
    if (next) next(); else running = false;
  }
}

/** Decode a `data:image/jpeg;base64,…` URL (size-checked by the caller's schema). */
export function decodeJpegDataUrl(dataUrl: string): { data: Uint8Array; width: number; height: number } {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buf = Buffer.from(b64, 'base64');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jpeg = require('jpeg-js');
  let raw: { data: Uint8Array; width: number; height: number };
  try {
    raw = jpeg.decode(buf, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: 0.5, maxMemoryUsageInMB: 32 });
  } catch {
    throw new AppError(400, 'A captured frame could not be read — please try again.');
  }
  if (raw.width > MAX_FRAME_EDGE || raw.height > MAX_FRAME_EDGE || raw.width < 64 || raw.height < 64) {
    throw new AppError(400, `Captured frames must be between 64 and ${MAX_FRAME_EDGE} px — please update the app and try again.`);
  }
  return raw;
}

function greyThumb(rgb: Uint8Array, w: number, h: number, n = 16): Float32Array {
  const out = new Float32Array(n * n);
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const x = Math.min(w - 1, Math.floor((tx + 0.5) * w / n)), y = Math.min(h - 1, Math.floor((ty + 0.5) * h / n));
      const i = (y * w + x) * 3;
      out[ty * n + tx] = (rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114) / 255;
    }
  }
  return out;
}

/** Mean absolute difference of two thumbnails, 0–1. */
export function thumbDiff(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

async function analyseDecoded(faceapi: FaceApi, raw: { data: Uint8Array; width: number; height: number }): Promise<FrameAnalysis> {
  const thumb = greyThumb(raw.data, raw.width, raw.height);
  const tensor = faceapi.tf.tensor3d(raw.data, [raw.height, raw.width, 3], 'int32');
  try {
    // Same detector settings as the browser (client/src/shared/face.ts), so a
    // frame the client accepted is judged by the same eyes here.
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    const dets = await faceapi.detectAllFaces(tensor, options).withFaceLandmarks(true).withFaceDescriptors();
    const base = { faces: dets.length, width: raw.width, height: raw.height, thumb, grey: toGrey(raw.data, raw.width, raw.height) };
    if (dets.length !== 1) return base;
    const d = dets[0];
    const pts: Pt[] = d.landmarks.positions.map((p: Pt) => ({ x: p.x, y: p.y }));
    return {
      ...base,
      geometry: faceGeometry(pts),
      landmarks: pts,
      descriptor: Array.from(d.descriptor as Float32Array),
      score: d.detection.score,
      box: { x: d.detection.box.x, y: d.detection.box.y, width: d.detection.box.width, height: d.detection.box.height },
    };
  } finally {
    tensor.dispose();
  }
}

/**
 * Analyse a set of JPEG data URLs (decoded first, so a malformed frame fails
 * fast before any model time is spent). Returns per-frame results and the
 * CPU time the analysis took.
 */
export async function analyseFrames(frames: string[]): Promise<{ frames: FrameAnalysis[]; cpuMs: number; wallMs: number }> {
  const decoded = frames.map(decodeJpegDataUrl);
  const faceapi = await loadEngine();
  return exclusive(async () => {
    const cpu0 = process.cpuUsage(), t0 = Date.now();
    const out: FrameAnalysis[] = [];
    for (const raw of decoded) out.push(await analyseDecoded(faceapi, raw));
    const cpu = process.cpuUsage(cpu0);
    return { frames: out, cpuMs: Math.round((cpu.user + cpu.system) / 1000), wallMs: Date.now() - t0 };
  });
}
