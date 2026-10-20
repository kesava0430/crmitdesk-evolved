/**
 * Browser-side face capture for attendance (enrolment + check-in).
 *
 * Loads @vladmandic/face-api lazily (it pulls in TensorFlow.js, ~1 MB gz) so the
 * rest of the app never pays for it. The browser's job is to GUIDE the person
 * through the server's liveness challenge in real time (trackFace + the shared
 * metrics in livenessMetrics.ts) and to capture a few small frames. It is not
 * trusted: the server re-detects the face, landmarks and descriptor in those
 * frames itself (server/src/utils/liveness). Model weights are served from
 * /models/face (client/public/models/face) — the same files the server loads.
 */

import { asset } from './asset';

type FaceApi = typeof import('@vladmandic/face-api');

let faceApiPromise: Promise<FaceApi> | null = null;

export const MODEL_URL = asset('models/face');

export async function loadFaceApi(): Promise<FaceApi> {
  if (!faceApiPromise) {
    faceApiPromise = (async () => {
      const faceapi = await import('@vladmandic/face-api');
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      return faceapi;
    })().catch(err => { faceApiPromise = null; throw err; });
  }
  return faceApiPromise;
}

/** Face box relative to the frame (0–1), for the on-screen guide. */
export interface FaceBox { x: number; y: number; width: number; height: number }

export type FaceTrack =
  | { status: 'ok'; landmarks: { x: number; y: number }[]; descriptor?: number[]; box: FaceBox }
  | { status: 'none' }
  | { status: 'multiple' }
  | { status: 'small'; box: FaceBox };

/** Longest edge of the frames analysed here AND uploaded (the server caps at 640). */
export const FRAME_EDGE = 320;

/**
 * Copy the current video frame into a small canvas. Detection runs on this
 * canvas and, when a frame is kept, this same canvas is encoded — so the
 * server analyses exactly the pixels the client judged, at the same size.
 */
export function grabFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement = document.createElement('canvas')): HTMLCanvasElement {
  const vw = video.videoWidth || FRAME_EDGE, vh = video.videoHeight || Math.round(FRAME_EDGE * 0.75);
  const scale = Math.min(1, FRAME_EDGE / Math.max(vw, vh));
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.getContext('2d')?.drawImage(video, 0, 0, w, h);
  return canvas;
}

/**
 * One tracking step for the liveness flow: landmarks every frame (cheap), the
 * descriptor only when asked (the recognition net is the expensive part) — used
 * to make sure the same face stays in front of the camera.
 */
export async function trackFace(frame: HTMLCanvasElement, withDescriptor = false): Promise<FaceTrack> {
  const faceapi = await loadFaceApi();
  // Same detector settings as the server (server/src/utils/liveness/faceEngine.ts).
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const base = faceapi.detectAllFaces(frame, options).withFaceLandmarks(true);
  const detections = withDescriptor ? await base.withFaceDescriptors() : await base;
  if (detections.length === 0) return { status: 'none' };
  if (detections.length > 1) return { status: 'multiple' };
  const d = detections[0] as (typeof detections)[number] & { descriptor?: Float32Array };
  const { x, y, width, height } = d.detection.box;
  const vw = frame.width || 1, vh = frame.height || 1;
  const box = { x: x / vw, y: y / vh, width: width / vw, height: height / vh };
  if (width / vw < 0.18) return { status: 'small', box };
  return {
    status: 'ok', box,
    landmarks: d.landmarks.positions.map(p => ({ x: p.x, y: p.y })),
    descriptor: d.descriptor ? Array.from(d.descriptor) : undefined,
  };
}

/** The server refuses frames over this many characters (server/src/utils/faceVerification.ts). */
const MAX_FRAME_CHARS = 58_000;

/**
 * JPEG data URL of a grabbed frame, within the server's size limit. Not
 * mirrored — the preview is flipped with CSS, the pixels the server analyses
 * are what the camera saw.
 */
export function encodeFrame(canvas: HTMLCanvasElement, quality = 0.8): string {
  for (let q = quality; q >= 0.4; q -= 0.15) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= MAX_FRAME_CHARS) return url;
  }
  return canvas.toDataURL('image/jpeg', 0.35);
}

export async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not supported in this browser.');
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (err: any) {
    if (err?.name === 'NotAllowedError') throw new Error('Camera permission was denied — allow camera access for this site and try again.');
    if (err?.name === 'NotFoundError') throw new Error('No camera was found on this device.');
    throw new Error(err?.message || 'Could not start the camera.');
  }
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach(t => t.stop());
}
