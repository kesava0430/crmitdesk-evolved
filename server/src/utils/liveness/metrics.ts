// ─── Face liveness metrics (pure, shared) ────────────────────────────────────
//
// KEEP IN SYNC: this file is copied byte-for-byte to
// client/src/shared/livenessMetrics.ts (a unit test fails if they differ).
// The browser uses it to guide the person through the challenge in real time;
// the server runs the SAME maths on landmarks it detects itself in the
// uploaded frames, so the client's opinion is never what decides.
//
// Inputs are face-api's 68 landmarks (iBUG 300-W layout) in the coordinates
// of an UNMIRRORED camera frame — the preview on screen is mirrored with CSS,
// the captured pixels are not.
//
// Why these signals and not others:
//  - Head turn is the anti-photo signal. The nose tip sits ~0.45 inter-ocular
//    distances in front of the eyes, so when a real head turns the nose tip
//    leaves the line from the top of the nose bridge to the chin (yaw), and
//    the two halves of the face either side of that line become unequal
//    (asymmetry). Both are measured as RATIOS OF TRIANGLE AREAS, which is
//    what makes them hold against a photo: moving, rotating or tilting a flat
//    picture in front of a camera is (up to perspective) an affine map of the
//    picture, and affine maps preserve area ratios exactly. So however a
//    printed photo or a phone screen is turned, both numbers stay where they
//    were; only something with real depth changes them. An earlier version
//    measured distances along the eye axis — perspective shear on a photo held
//    close to the lens rotates that axis and leaked into the reading; the
//    area form has no preferred axis to leak through. Both cues must change,
//    in the coupled way a real head produces.
//    In practice the tiny landmark net leans toward an average face and
//    partly reads a strongly squeezed photo as turned: a real photo rotated
//    60° as a card measured Δyaw 0.115 (the detector loses it beyond ~60–65°).
//    Hence two bars: a STRONG turn (≥ 0.15, past anything a flat card
//    produced) stands on its own; a WEAK one (≥ 0.09) only counts when the
//    server's pixel test (planarity.ts, server only) positively sees 3D
//    parallax. Relaxed three-quarter poses in real photos measured 0.16–0.27.
//  - Mouth opening (inner-lip gap ÷ mouth width) is large and easy to see.
//  - Blink is NOT used: on face-api's 68-point models the eyelid points hardly
//    move — a face with visibly closed eyes measured an eye aspect ratio of
//    0.24, inside the 0.22–0.39 range of open eyes in the same sample set.
//    eyeAspectRatio is still computed for diagnostics.

export interface Pt { x: number; y: number }

export const LIVENESS_STEPS = ['turn_left', 'turn_right', 'open_mouth'] as const;
export type LivenessStep = (typeof LIVENESS_STEPS)[number];

export interface FaceGeometry {
  /** Signed area(nose bridge, chin, nose tip) ÷ area(left eye, right eye,
   *  chin) — the nose tip's sideways offset from the face midline, roughly
   *  in inter-ocular units. + = nose toward image right = the person turning
   *  to THEIR left. Affine-invariant: a flat picture can't change it. */
  yaw: number;
  /** (right half − left half) ÷ (right + left), the halves being the
   *  triangles from the midline (bridge–chin) to each jaw corner. Moves
   *  opposite to yaw on a real head. Also affine-invariant. */
  asym: number;
  /** Mouth aspect ratio: inner-lip gap ÷ inner mouth width. */
  mar: number;
  /** Mean eye aspect ratio (diagnostic only — see header). */
  ear: number;
  /** Inter-ocular distance ÷ face width (diagnostic). */
  iodRatio: number;
  /** Face width (jaw corner to jaw corner) ÷ nose-bridge-to-chin
   *  height. Diagnostic only: geometrically a flat picture turned by φ is
   *  squeezed to cos φ, but the landmark net regresses toward an average face
   *  shape, so measured values barely moved (0.93 vs 1.11 at 60°). */
  aspect: number;
}

export const LIVENESS = {
  /** The start frame must look roughly straight at the camera. */
  neutralMaxYaw: 0.14,
  /** A turn: nose must leave the midline by at least this much (|Δyaw|) … */
  turnMinYaw: 0.09,
  /** … AND the face halves must become unequal by this much, in the opposite
   *  sense (real heads measured |Δasym| ≈ 2×|Δyaw|). */
  turnMinAsym: 0.12,
  /** A turn this clear needs no pixel-level confirmation (see header). */
  turnStrongYaw: 0.15,
  turnStrongAsym: 0.18,
  /** Beyond this the "face" is not a head any more: real turned faces measured
   *  |yaw| ≤ 0.36 and the detector loses a face well before 0.6. Extreme
   *  perspective on a flat picture held at a steep angle right at the lens
   *  can push the ratios this far; such frames count as no 3D motion. */
  maxPlausibleYaw: 0.6,
  mouthMinMar: 0.32,
  mouthMinMarDelta: 0.15,
  /** If no frame's yaw differs from the start by more than this, nothing in
   *  front of the camera rotated in 3D — the classic photo/screen signature. */
  photoMaxYawDelta: 0.05,
  /** The end frame must come back near the start pose. */
  endMaxYawDrift: 0.15,
  /** Descriptor distance under which two frames are the same person
   *  (face-api's conventional same-person limit). */
  sameFaceMaxDistance: 0.6,
  /** The client waits for this much MORE than the server needs before it
   *  captures a step frame, so JPEG compression and re-detection noise on the
   *  server can't flip a genuine pass into a fail. */
  clientFactor: 1.2,
} as const;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (pts: Pt[]): Pt => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

/** Eye aspect ratio of one eye given its 6 landmarks (Soukupová & Čech). */
export function eyeAspectRatio(eye: Pt[]): number {
  const w = dist(eye[0], eye[3]);
  return w > 0 ? (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * w) : 0;
}

/** Inner-lip gap ÷ inner mouth width (landmarks 60–67). */
export function mouthAspectRatio(pts: Pt[]): number {
  const w = dist(pts[60], pts[64]);
  if (!(w > 0)) return 0;
  return (dist(pts[61], pts[67]) + dist(pts[62], pts[66]) + dist(pts[63], pts[65])) / (3 * w);
}

/** Twice the signed area of triangle abc (positive when a→b→c turns clockwise on screen, y down). */
const area2 = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

export function faceGeometry(pts: Pt[]): FaceGeometry {
  if (!Array.isArray(pts) || pts.length !== 68) throw new Error('Expected 68 landmarks');
  const leftEye = pts.slice(36, 42), rightEye = pts.slice(42, 48);
  const lc = centroid(leftEye), rc = centroid(rightEye);
  const iod = dist(lc, rc);
  const bridge = pts[27], chin = pts[8], nose = pts[30];
  // Eyes→chin triangle: the face's own scale, in the same (area) units.
  const faceArea = area2(lc, rc, chin);
  if (!(iod > 0) || !(Math.abs(faceArea) > 0)) throw new Error('Degenerate landmarks');
  // Nose tip relative to the midline. area2(bridge, chin, nose) is
  // |midline| × offset; faceArea is ≈ iod × |midline|, so the ratio reads as
  // the offset in inter-ocular units (sign: + when the nose is right of the
  // line looking down it from bridge to chin, i.e. toward image right).
  const yaw = -area2(bridge, chin, nose) / faceArea;
  const left = Math.abs(area2(bridge, chin, pts[0])), right = Math.abs(area2(bridge, chin, pts[16]));
  const halves = left + right;
  const width = dist(pts[0], pts[16]), height = dist(bridge, chin);
  return {
    yaw,
    asym: halves > 0 ? (right - left) / halves : 0,
    mar: mouthAspectRatio(pts),
    ear: (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2,
    iodRatio: width > 0 ? iod / width : 0,
    aspect: height > 0 ? width / height : 0,
  };
}

export type StepReason = 'ok' | 'not_enough' | 'wrong_direction' | 'no_3d_motion';

export interface StepResult {
  ok: boolean;
  /** For turns: past the strong bar (needs no pixel-level confirmation). */
  strong: boolean;
  reason: StepReason;
  yawDelta: number;
  asymDelta: number;
  marDelta: number;
}

/**
 * Did `frame` perform `step` relative to the `neutral` start frame?
 * `factor` > 1 makes it stricter (the client uses LIVENESS.clientFactor).
 */
export function evaluateStep(step: LivenessStep, neutral: FaceGeometry, frame: FaceGeometry, factor = 1): StepResult {
  const yawDelta = frame.yaw - neutral.yaw;
  const asymDelta = frame.asym - neutral.asym;
  const marDelta = frame.mar - neutral.mar;
  const base = { yawDelta, asymDelta, marDelta, strong: false };
  if (step === 'open_mouth') {
    const ok = frame.mar >= LIVENESS.mouthMinMar * factor && marDelta >= LIVENESS.mouthMinMarDelta * factor;
    return { ...base, ok, strong: ok, reason: ok ? 'ok' : 'not_enough' };
  }
  if (Math.abs(frame.yaw) > LIVENESS.maxPlausibleYaw || Math.abs(neutral.yaw) > LIVENESS.maxPlausibleYaw) {
    return { ...base, ok: false, reason: 'no_3d_motion' };
  }
  const dir = step === 'turn_left' ? 1 : -1;
  const minYaw = LIVENESS.turnMinYaw * factor, minAsym = LIVENESS.turnMinAsym * factor;
  const noseMoved = yawDelta * dir >= minYaw;
  const halvesMoved = -asymDelta * dir >= minAsym;
  if (noseMoved && halvesMoved) {
    const strong = yawDelta * dir >= LIVENESS.turnStrongYaw * factor && -asymDelta * dir >= LIVENESS.turnStrongAsym * factor;
    return { ...base, ok: true, strong, reason: 'ok' };
  }
  // A clear turn the other way.
  if (-yawDelta * dir >= minYaw && asymDelta * dir >= minAsym) return { ...base, ok: false, reason: 'wrong_direction' };
  // One cue without the other is not how a head moves: the face halves went
  // unequal while the nose stayed put (perspective on a tilted flat image),
  // or the nose "moved" with no matching change in the face outline.
  if (Math.abs(asymDelta) >= minAsym || Math.abs(yawDelta) >= minYaw) return { ...base, ok: false, reason: 'no_3d_motion' };
  return { ...base, ok: false, reason: 'not_enough' };
}

/** Which step (if any) a frame clearly shows. Used to spot steps done out of order. */
export function classifyFrame(neutral: FaceGeometry, frame: FaceGeometry, factor = 1): LivenessStep | null {
  for (const s of LIVENESS_STEPS) if (evaluateStep(s, neutral, frame, factor).ok) return s;
  return null;
}

export type SequenceReason =
  | 'ok'
  | 'not_facing_camera'
  | 'photo_suspected'
  | 'steps_out_of_order'
  | 'wrong_direction'
  | 'step_not_performed'
  | 'end_not_neutral';

export interface SequenceResult {
  ok: boolean;
  reason: SequenceReason;
  /** Index into `steps` of the first failing step, when relevant. */
  failedStep?: number;
  steps: StepResult[];
}

/**
 * Frames are [neutral start, one peak frame per step in challenge order, neutral end].
 */
export function evaluateSequence(steps: readonly LivenessStep[], frames: FaceGeometry[]): SequenceResult {
  if (frames.length !== steps.length + 2) return { ok: false, reason: 'step_not_performed', steps: [] };
  const start = frames[0], end = frames[frames.length - 1];
  const results = steps.map((s, i) => evaluateStep(s, start, frames[i + 1]));
  if (Math.abs(start.yaw) > LIVENESS.neutralMaxYaw) return { ok: false, reason: 'not_facing_camera', steps: results };

  // Nothing rotated in 3D at all although a turn was asked for: a photo or a
  // screen, however it was moved. Checked before per-step reasons so the log
  // says what actually happened.
  const maxYawShift = Math.max(...frames.map(f => Math.abs(f.yaw - start.yaw)));
  if (steps.some(s => s !== 'open_mouth') && maxYawShift < LIVENESS.photoMaxYawDelta) {
    return { ok: false, reason: 'photo_suspected', steps: results };
  }

  for (let i = 0; i < steps.length; i++) {
    const r = results[i];
    if (r.ok) continue;
    const shown = classifyFrame(start, frames[i + 1]);
    if (shown && shown !== steps[i] && steps.includes(shown)) return { ok: false, reason: 'steps_out_of_order', failedStep: i, steps: results };
    if (r.reason === 'no_3d_motion') return { ok: false, reason: 'photo_suspected', failedStep: i, steps: results };
    if (r.reason === 'wrong_direction') return { ok: false, reason: 'wrong_direction', failedStep: i, steps: results };
    return { ok: false, reason: 'step_not_performed', failedStep: i, steps: results };
  }
  if (Math.abs(end.yaw - start.yaw) > LIVENESS.endMaxYawDrift) return { ok: false, reason: 'end_not_neutral', steps: results };
  return { ok: true, reason: 'ok', steps: results };
}

/** Euclidean distance between two descriptors. */
export function descriptorDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}
