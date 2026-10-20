// ─── Liveness challenges: issue, consume, verify ─────────────────────────────
//
// Flow: POST /hr/attendance/face/challenge issues a random sequence of 2–3
// actions bound to (user, purpose) with a ~90 s lifetime. The client guides
// the person through it and uploads 4–5 small JPEG frames: neutral start, the
// peak of each step in order, neutral end. verifyLiveness() spends the
// challenge first (compare-and-set — single use even under a race), then
// analyses the frames ITSELF (faceEngine.ts) and checks, with the same maths
// the client used (metrics.ts):
//   - exactly one face in every frame,
//   - every frame is the same person,
//   - the frames are not one static image repeated,
//   - the steps happened, in the issued order, with real 3D head motion —
//     landmark ratios a flat picture can't change (metrics.ts) AND pixel
//     motion no single homography explains (planarity.ts),
//   - (check-in/out) the neutral frames match the enrolment.
// Nothing the client computed is trusted; descriptors stored at enrolment
// come from the server's own analysis too.

import crypto from 'crypto';
import { prisma } from '../prisma';
import { AppError } from '../../middleware/errorHandler';
import { logAction } from '../auditLog';
import { analyseFrames, thumbDiff, type FrameAnalysis } from './faceEngine';
import { evaluateSequence, descriptorDistance, LIVENESS, LIVENESS_STEPS, type LivenessStep } from './metrics';
import { planarMotion } from './planarity';

export type LivenessPurpose = 'CHECK_IN' | 'CHECK_OUT' | 'ENROL';

export const CHALLENGE_TTL_MS = 90_000;
/** Nobody does 2–3 deliberate head movements faster than this; a script does. */
export const MIN_HUMAN_MS = 1_500;
export const FAIL_WINDOW_MS = 10 * 60_000;
export const MAX_FAILS_PER_WINDOW = 5;
/** An ENROL pass may stand in for the check-in right after it, within this window. */
export const REDEEM_WINDOW_MS = 3 * 60_000;
/** Frames whose 16×16 thumbnails differ by less than this are the same picture. */
const STATIC_THUMB_DIFF = 0.004;

export const LIVENESS_FAILED_MESSAGE = "Liveness check failed — make sure you're in good light and follow the prompts.";

export type FailureReason =
  | 'challenge_invalid' | 'challenge_used' | 'timeout' | 'too_fast' | 'bad_frames'
  | 'no_face' | 'multiple_faces' | 'face_changed' | 'static_frames'
  | 'not_facing_camera' | 'photo_suspected' | 'steps_out_of_order' | 'wrong_direction'
  | 'step_not_performed' | 'end_not_neutral' | 'motion_unconfirmed' | 'face_mismatch';

export function livenessError(reason: FailureReason, message = LIVENESS_FAILED_MESSAGE, status = 403) {
  const err = new AppError(status, message);
  (err as any).code = 'LIVENESS_FAILED';
  (err as any).reason = reason;
  return err;
}

/** Old installed Android apps still post a bare descriptor; tell them to update rather than silently accept. */
export function appUpdateRequiredError() {
  const err = new AppError(426, 'Face verification now includes a liveness check. Please update the Zenkara 360 app (or reload the web page) and try again.');
  (err as any).code = 'APP_UPDATE_REQUIRED';
  return err;
}

/**
 * Random 2–3 distinct steps, always including at least one head turn — the
 * turn is what a flat photo cannot fake, so it is never optional.
 */
export function pickSteps(randInt: (maxExclusive: number) => number = crypto.randomInt): LivenessStep[] {
  const count = 2 + randInt(2);
  const pool = [...LIVENESS_STEPS];
  for (let i = pool.length - 1; i > 0; i--) { const j = randInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  let steps = pool.slice(0, count);
  if (!steps.some(s => s !== 'open_mouth')) steps = [steps[0], randInt(2) ? 'turn_left' : 'turn_right'];
  return steps;
}

export interface ChallengeRow {
  id: string; orgId: string; userId: string; purpose: string; steps: unknown;
  expiresAt: Date; usedAt: Date | null; createdAt: Date;
}

/**
 * Why a challenge row can't be spent (null = it can). Pure, for the tests:
 * unknown/other user/other purpose look identical to the caller on purpose.
 */
export function challengeRejection(row: ChallengeRow | null, userId: string, purpose: LivenessPurpose, now: Date): FailureReason | null {
  if (!row || row.userId !== userId || row.purpose !== purpose) return 'challenge_invalid';
  if (row.usedAt) return 'challenge_used';
  if (row.expiresAt.getTime() <= now.getTime()) return 'timeout';
  return null;
}

/** Minimal slice of the Prisma client this module needs — lets tests pass an in-memory fake. */
export interface ChallengeStore {
  faceLivenessChallenge: {
    create(args: any): Promise<any>;
    findUnique(args: any): Promise<any>;
    updateMany(args: any): Promise<{ count: number }>;
    update(args: any): Promise<any>;
    count(args: any): Promise<number>;
    findFirst(args: any): Promise<any>;
  };
}
const db = (): ChallengeStore => prisma as unknown as ChallengeStore;

export async function recentFailures(userId: string, now = new Date(), store: ChallengeStore = db()): Promise<{ count: number; retryAfterMin: number }> {
  const since = new Date(now.getTime() - FAIL_WINDOW_MS);
  const count = await store.faceLivenessChallenge.count({ where: { userId, result: 'FAILED', usedAt: { gte: since } } });
  if (count < MAX_FAILS_PER_WINDOW) return { count, retryAfterMin: 0 };
  const oldest = await store.faceLivenessChallenge.findFirst({
    where: { userId, result: 'FAILED', usedAt: { gte: since } }, orderBy: { usedAt: 'desc' }, skip: MAX_FAILS_PER_WINDOW - 1, select: { usedAt: true },
  });
  const freeAt = (oldest?.usedAt ? new Date(oldest.usedAt).getTime() : now.getTime()) + FAIL_WINDOW_MS;
  return { count, retryAfterMin: Math.max(1, Math.ceil((freeAt - now.getTime()) / 60_000)) };
}

export async function issueChallenge(orgId: string, userId: string, purpose: LivenessPurpose, now = new Date(), store: ChallengeStore = db()) {
  const fails = await recentFailures(userId, now, store);
  if (fails.retryAfterMin > 0) {
    const err = new AppError(429, `Too many failed face checks. Please wait ${fails.retryAfterMin} minute${fails.retryAfterMin === 1 ? '' : 's'} and try again, or ask a manager to add a manual entry.`);
    (err as any).code = 'LIVENESS_RATE_LIMITED';
    throw err;
  }
  const steps = pickSteps();
  const row = await store.faceLivenessChallenge.create({
    data: {
      id: crypto.randomBytes(18).toString('base64url'),
      orgId, userId, purpose, steps,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    },
  });
  return {
    challengeId: row.id as string,
    steps,
    expiresAt: (row.expiresAt as Date).toISOString(),
    /** What the server will accept, so the client can be told rather than guess. */
    frames: { count: steps.length + 2, maxEdge: 320 },
  };
}

/**
 * Spend a challenge: compare-and-set on usedAt, so of two concurrent
 * submissions exactly one gets it. Throws LIVENESS_FAILED with the reason.
 */
export async function consumeChallenge(id: string, userId: string, purpose: LivenessPurpose, now = new Date(), store: ChallengeStore = db()): Promise<ChallengeRow> {
  const claimed = await store.faceLivenessChallenge.updateMany({
    where: { id, userId, purpose, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  const row = await store.faceLivenessChallenge.findUnique({ where: { id } }) as ChallengeRow | null;
  if (claimed.count === 1 && row) return row;
  const reason = challengeRejection(row, userId, purpose, now) ?? 'challenge_used';
  // An expired challenge belongs to this user: record the timeout against it
  // (rate limit + audit). Someone else's or an unknown id is not recorded on
  // that row — we'd be letting one user write to another's challenge.
  if (reason === 'timeout' && row && !row.usedAt) {
    await store.faceLivenessChallenge.updateMany({ where: { id, usedAt: null }, data: { usedAt: now, result: 'FAILED', failureReason: 'timeout' } });
    logAction(userId, 'UPDATE', 'FaceLiveness', id, { result: 'FAILED', reason: 'timeout', purpose });
  }
  throw livenessError(reason, reason === 'timeout'
    ? 'The face check took too long — please try again and follow the prompts.'
    : 'This face check has already been used or is not valid — please try again.');
}

export interface LivenessInput {
  challengeId: string;
  frames: string[];
}

export interface LivenessPass {
  challengeId: string;
  /** Server-computed descriptor of each frame (all the same person). */
  descriptors: number[][];
  /** The neutral start frame — the evidence photo kept on the record. */
  neutralFrame: string;
  frames: string[];
  /** Best distance of a neutral frame to the enrolment (null when no enrolment was compared). */
  distance: number | null;
  matched: boolean | null;
}

/** Pure decision over analysed frames; exported for the tests. */
export function judgeFrames(steps: LivenessStep[], analysed: FrameAnalysis[], enrolled: number[][] | null, threshold: number):
  { ok: true; distance: number | null; matched: boolean | null; details: Record<string, unknown> } |
  { ok: false; reason: FailureReason; details: Record<string, unknown> } {
  const perFrame = analysed.map(a => ({ faces: a.faces, score: a.score != null ? +a.score.toFixed(3) : null, ...(a.geometry ? roundGeo(a.geometry) : {}) }));
  const details: Record<string, unknown> = { steps, frames: perFrame };
  if (analysed.some(a => a.faces === 0)) return { ok: false, reason: 'no_face', details };
  if (analysed.some(a => a.faces > 1)) return { ok: false, reason: 'multiple_faces', details };

  // The same picture over and over (a photo replayed through the API, or a
  // perfectly still screen) — caught before any geometry, it needs no more.
  const diffs = analysed.slice(1).map(a => thumbDiff(analysed[0].thumb, a.thumb));
  details.maxFrameDiff = +Math.max(...diffs).toFixed(4);
  if (diffs.every(d => d < STATIC_THUMB_DIFF)) return { ok: false, reason: 'static_frames', details };

  const d0 = analysed[0].descriptor!;
  const sameness = analysed.map(a => descriptorDistance(d0, a.descriptor!));
  details.sameFace = sameness.map(v => +v.toFixed(3));
  if (sameness.some(v => v > LIVENESS.sameFaceMaxDistance)) return { ok: false, reason: 'face_changed', details };

  const seq = evaluateSequence(steps, analysed.map(a => a.geometry!));
  details.sequence = { reason: seq.reason, failedStep: seq.failedStep ?? null, steps: seq.steps.map(s => ({ ok: s.ok, strong: s.strong, reason: s.reason, dYaw: +s.yawDelta.toFixed(3), dAsym: +s.asymDelta.toFixed(3), dMar: +s.marDelta.toFixed(3) })) };

  // Each turn, at pixel level: a flat picture moves as one plane. Run for
  // every turn the landmarks say happened (or that looked like "no 3D
  // motion") BEFORE reporting sequence problems, so a photo is logged as a
  // photo even when its squeezed face also confused another step.
  const planarity: Record<string, unknown>[] = [];
  const verdicts = new Map<number, 'planar' | 'non_planar' | 'inconclusive'>();
  for (let i = 0; i < steps.length && i < seq.steps.length; i++) {
    const st = seq.steps[i];
    if (steps[i] === 'open_mouth' || !(st.ok || st.reason === 'no_3d_motion')) continue;
    const a = analysed[0], b = analysed[i + 1];
    const r = planarMotion(a.grey, b.grey, a.landmarks!, b.landmarks!);
    planarity.push({ step: i, strong: st.strong, ...r });
    verdicts.set(i, r.verdict);
  }
  details.planarity = planarity;
  if ([...verdicts.values()].includes('planar')) return { ok: false, reason: 'photo_suspected', details };

  if (!seq.ok) {
    // The landmarks saw an incoherent "turn" but the pixels show real depth:
    // a genuine head that simply didn't turn far enough, not a photo.
    if (seq.reason === 'photo_suspected' && seq.failedStep != null && verdicts.get(seq.failedStep) === 'non_planar') {
      return { ok: false, reason: 'step_not_performed', details };
    }
    return { ok: false, reason: seq.reason as FailureReason, details };
  }

  // A weak turn needs a positive 3D verdict (inconclusive = too blurry/dark
  // to tell, which is what the "good light" message asks the person to fix).
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] !== 'open_mouth' && !seq.steps[i].strong && verdicts.get(i) !== 'non_planar') {
      return { ok: false, reason: 'motion_unconfirmed', details };
    }
  }

  if (!enrolled) return { ok: true, distance: null, matched: null, details };
  const neutrals = [analysed[0], analysed[analysed.length - 1]];
  const distance = Math.min(...neutrals.flatMap(n => enrolled.map(e => descriptorDistance(n.descriptor!, e))));
  details.distance = +distance.toFixed(4);
  return { ok: true, distance: +distance.toFixed(4), matched: distance <= threshold, details };
}

function roundGeo(g: { yaw: number; asym: number; mar: number; ear: number }) {
  return { yaw: +g.yaw.toFixed(3), asym: +g.asym.toFixed(3), mar: +g.mar.toFixed(3), ear: +g.ear.toFixed(3) };
}

/**
 * Spend the challenge and verify the frames on the server. Throws
 * LIVENESS_FAILED (403) on any liveness failure; a live face that simply
 * doesn't match the enrolment is returned as matched=false, so the caller's
 * attendance rule decides (exactly like a mismatching descriptor before).
 * Both are recorded as failures for the rate limit and the audit log.
 */
export async function verifyLiveness(opts: {
  orgId: string; userId: string; purpose: LivenessPurpose; input: LivenessInput;
  enrolled: number[][] | null; threshold: number; now?: Date;
}): Promise<LivenessPass> {
  const now = opts.now ?? new Date();
  const { challengeId, frames } = opts.input;
  // Checked again at submission: challenges fetched in bulk while under the
  // limit must not let someone keep trying past it.
  if ((await recentFailures(opts.userId, now)).retryAfterMin > 0) {
    const err = new AppError(429, 'Too many failed face checks. Please wait a few minutes and try again, or ask a manager to add a manual entry.');
    (err as any).code = 'LIVENESS_RATE_LIMITED';
    throw err;
  }
  const row = await consumeChallenge(challengeId, opts.userId, opts.purpose, now);
  const steps = (Array.isArray(row.steps) ? row.steps : []) as LivenessStep[];

  const fail = async (reason: FailureReason, details: Record<string, unknown>, evidence?: string): Promise<never> => {
    await prisma.faceLivenessChallenge.update({
      where: { id: challengeId },
      data: { result: 'FAILED', failureReason: reason, details: details as any, evidenceFrame: evidence ?? null },
    });
    logAction(opts.userId, 'UPDATE', 'FaceLiveness', challengeId, { result: 'FAILED', reason, purpose: opts.purpose, steps });
    throw livenessError(reason);
  };

  if (frames.length !== steps.length + 2) return fail('bad_frames', { steps, got: frames.length });
  if (now.getTime() - row.createdAt.getTime() < MIN_HUMAN_MS) return fail('too_fast', { steps, ms: now.getTime() - row.createdAt.getTime() }, frames[0]);

  let analysis: Awaited<ReturnType<typeof analyseFrames>>;
  try {
    analysis = await analyseFrames(frames);
  } catch (err: any) {
    // A busy engine is not the person's fault: the challenge is spent (it
    // can't be handed back safely) but it doesn't count as a failed attempt.
    if (err?.code === 'FACE_ENGINE_BUSY') {
      await prisma.faceLivenessChallenge.update({ where: { id: challengeId }, data: { failureReason: 'engine_busy' } });
      throw err;
    }
    if (err instanceof AppError) return fail('bad_frames', { steps, error: err.message }, undefined);
    throw err;
  }

  const verdict = judgeFrames(steps, analysis.frames, opts.enrolled, opts.threshold);
  const details = { ...verdict.details, cpuMs: analysis.cpuMs, wallMs: analysis.wallMs, elapsedMs: now.getTime() - row.createdAt.getTime() };
  if (!verdict.ok) return fail(verdict.reason, details, frames[0]);

  const descriptors = analysis.frames.map(f => f.descriptor!.map(v => +v.toFixed(6)));
  if (verdict.matched === false) {
    await prisma.faceLivenessChallenge.update({
      where: { id: challengeId },
      data: { result: 'FAILED', failureReason: 'face_mismatch', details: details as any, evidenceFrame: frames[0] },
    });
    logAction(opts.userId, 'UPDATE', 'FaceLiveness', challengeId, { result: 'FAILED', reason: 'face_mismatch', purpose: opts.purpose, distance: verdict.distance });
  } else {
    await prisma.faceLivenessChallenge.update({
      where: { id: challengeId },
      // An ENROL pass keeps its start-frame descriptor so the check-in that
      // follows a first enrolment can redeem it (redeemEnrolChallenge).
      data: { result: 'PASSED', details: { ...details, ...(opts.purpose === 'ENROL' ? { descriptor: descriptors[0] } : {}) } as any },
    });
  }
  return { challengeId, descriptors, neutralFrame: frames[0], frames, distance: verdict.distance, matched: verdict.matched };
}

/**
 * The check-in straight after a first enrolment: the person just passed a
 * liveness check for ENROL, so spend that pass once instead of asking for a
 * second challenge. Compare-and-set on redeemedAt; same user; recent.
 */
export async function redeemEnrolChallenge(id: string, userId: string, now = new Date()): Promise<{ descriptor: number[]; frame: string | null } | null> {
  const claimed = await prisma.faceLivenessChallenge.updateMany({
    where: { id, userId, purpose: 'ENROL', result: 'PASSED', redeemedAt: null, usedAt: { gte: new Date(now.getTime() - REDEEM_WINDOW_MS) } },
    data: { redeemedAt: now },
  });
  if (claimed.count !== 1) return null;
  const row = await prisma.faceLivenessChallenge.findUnique({ where: { id }, select: { details: true } });
  const descriptor = (row?.details as any)?.descriptor;
  return Array.isArray(descriptor) ? { descriptor, frame: null } : null;
}

/**
 * The client gave up (timeout, face left the frame, wrong movement). Its word
 * is only used for the audit trail and to count towards the rate limit — it
 * can never make anything pass.
 */
export async function abandonChallenge(id: string, userId: string, reason: string, now = new Date()) {
  const clean = reason.replace(/[^a-z_]/g, '').slice(0, 40) || 'abandoned';
  const res = await prisma.faceLivenessChallenge.updateMany({
    where: { id, userId, usedAt: null },
    data: { usedAt: now, result: 'FAILED', failureReason: `client_${clean}` },
  });
  if (res.count === 1) logAction(userId, 'UPDATE', 'FaceLiveness', id, { result: 'FAILED', reason: `client_${clean}` });
  return res.count === 1;
}
