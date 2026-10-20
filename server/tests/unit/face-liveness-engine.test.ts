/**
 * Server-side liveness verification on REAL face images, through the real
 * engine (face-api on TF.js WASM — the same code path production runs).
 *
 * Fixtures (tests/fixtures/face) are crops of two people from
 * @vladmandic/face-api's demo photos (MIT), plus variants made from them:
 *   a_left / a_right / b_left / b_right — the head turned 30–38° by a 2.5D
 *     warp (per-landmark depth, rotated about a pivot inside the head,
 *     perspective projection, piecewise-affine warp). Parallax exists by
 *     construction, as with a real head, but these are not camera footage.
 *   a_mouth / b_mouth — jaw dropped and the mouth interior darkened.
 *   a_flat40 / a_flat60 / a_flatm60 — the whole photo rotated in 3D as a flat
 *     card (exact homography): a printed photo / phone screen turned in front
 *     of the camera.
 *   a_end — neutral again (2° off, so not byte-identical to a_neutral).
 * The generator script lives outside the repo; the images are what matters.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyseFrames, decodeJpegDataUrl, loadEngine } from '../../src/utils/liveness/faceEngine';
import { judgeFrames } from '../../src/utils/liveness/challenge';
import { planarMotion } from '../../src/utils/liveness/planarity';
import type { LivenessStep } from '../../src/utils/liveness/metrics';

const FIX = path.join(__dirname, '../fixtures/face');
const frame = (name: string) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(FIX, `${name}.jpg`)).toString('base64');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jpeg = require('jpeg-js');
const solid = (w: number, h: number, v = 128) => {
  const data = Buffer.alloc(w * h * 4, v);
  return 'data:image/jpeg;base64,' + jpeg.encode({ data, width: w, height: h }, 80).data.toString('base64');
};

async function judge(steps: LivenessStep[], names: string[], enrolled: number[][] | null = null) {
  const { frames, cpuMs, wallMs } = await analyseFrames(names.map(n => n.startsWith('data:') ? n : frame(n)));
  return { verdict: judgeFrames(steps, frames, enrolled, 0.5), cpuMs, wallMs, frames };
}

test('engine loads (WASM backend, models from node_modules)', { timeout: 60_000 }, async () => {
  const t0 = Date.now();
  const faceapi = await loadEngine();
  assert.equal(faceapi.tf.getBackend(), 'wasm');
  console.log(`# engine load ${Date.now() - t0} ms, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
});

test('a genuine sequence passes and its timing is reported', { timeout: 60_000 }, async () => {
  const r = await judge(['turn_left', 'open_mouth', 'turn_right'], ['a_neutral', 'a_left', 'a_mouth', 'a_right', 'a_end']);
  assert.ok(r.verdict.ok, JSON.stringify(r.verdict));
  console.log(`# 5-frame verification: ${r.cpuMs} ms CPU (analysis), ${r.wallMs} ms wall`);
  const t0 = process.cpuUsage();
  judgeFrames(['turn_left', 'open_mouth', 'turn_right'], r.frames, null, 0.5);
  const j = process.cpuUsage(t0);
  console.log(`# judge (incl. planarity): ${Math.round((j.user + j.system) / 1000)} ms CPU`);
  // Second person, different order.
  const b = await judge(['open_mouth', 'turn_left'], ['b_neutral', 'b_mouth', 'b_left', 'b_neutral']);
  // b_neutral is reused as the end frame here; the mouth/turn frames differ, so it's not "static".
  assert.ok(b.verdict.ok, JSON.stringify(b.verdict));
});

test('photo replay — the same image for every frame — fails', { timeout: 60_000 }, async () => {
  const r = await judge(['turn_left', 'turn_right'], ['a_neutral', 'a_neutral', 'a_neutral', 'a_neutral']);
  assert.equal(r.verdict.ok, false);
  assert.equal((r.verdict as any).reason, 'static_frames');
});

test('a photo turned as a flat card moves as one plane and fails, even next to a real mouth frame', { timeout: 60_000 }, async () => {
  const { frames } = await analyseFrames(['a_neutral', 'a_flat60', 'a_flatm60', 'a_flat40', 'a_left', 'a_right'].map(frame));
  const [n, f60, fm60, f40, left, right] = frames;
  for (const [name, f] of [['flat60', f60], ['flat-60', fm60], ['flat40', f40]] as const) {
    const p = planarMotion(n.grey, f.grey, n.landmarks!, f.landmarks!);
    assert.equal(p.verdict, 'planar', `${name}: ${JSON.stringify(p)}`);
  }
  for (const [name, f] of [['left', left], ['right', right]] as const) {
    const p = planarMotion(n.grey, f.grey, n.landmarks!, f.landmarks!);
    assert.equal(p.verdict, 'non_planar', `${name}: ${JSON.stringify(p)}`);
  }
  const r = await judge(['turn_left', 'open_mouth'], ['a_neutral', 'a_flat60', 'a_mouth', 'a_end']);
  assert.equal(r.verdict.ok, false);
  assert.equal((r.verdict as any).reason, 'photo_suspected', JSON.stringify(r.verdict));
  const r2 = await judge(['turn_left', 'turn_right'], ['a_neutral', 'a_flat60', 'a_flatm60', 'a_end']);
  assert.equal(r2.verdict.ok, false);
});

test('steps in the wrong order fail as out of order', { timeout: 60_000 }, async () => {
  const r = await judge(['turn_right', 'turn_left'], ['a_neutral', 'a_left', 'a_right', 'a_end']);
  assert.equal((r.verdict as any).reason, 'steps_out_of_order', JSON.stringify(r.verdict));
});

test('a different person mid-sequence fails as face changed', { timeout: 60_000 }, async () => {
  const r = await judge(['turn_left', 'open_mouth', 'turn_right'], ['a_neutral', 'b_left', 'a_mouth', 'a_right', 'a_end']);
  assert.equal((r.verdict as any).reason, 'face_changed', JSON.stringify(r.verdict));
});

test('no face / unreadable frames fail', { timeout: 60_000 }, async () => {
  const r = await judge(['turn_left', 'open_mouth'], ['a_neutral', solid(320, 240), 'a_mouth', 'a_end']);
  assert.equal((r.verdict as any).reason, 'no_face');
  assert.throws(() => decodeJpegDataUrl(solid(800, 600)), /between 64 and 640/);
  assert.throws(() => decodeJpegDataUrl('data:image/jpeg;base64,AAAA'), /could not be read/);
});

test('a live sequence is matched against the enrolment by the server', { timeout: 60_000 }, async () => {
  const enrolA = (await analyseFrames(['a_neutral', 'a_right'].map(frame))).frames.map(f => f.descriptor!);
  const enrolB = (await analyseFrames(['b_neutral', 'b_right'].map(frame))).frames.map(f => f.descriptor!);
  const seq: [LivenessStep[], string[]] = [['turn_right', 'open_mouth'], ['a_neutral', 'a_right', 'a_mouth', 'a_end']];
  const same = await judge(seq[0], seq[1], enrolA);
  assert.ok(same.verdict.ok && same.verdict.matched === true, JSON.stringify(same.verdict));
  const other = await judge(seq[0], seq[1], enrolB);
  assert.ok(other.verdict.ok && other.verdict.matched === false, `A must not match B's enrolment: ${JSON.stringify(other.verdict)}`);
  console.log(`# match distance same person ${same.verdict.ok && same.verdict.distance}, other person ${other.verdict.ok && other.verdict.distance}`);
});
