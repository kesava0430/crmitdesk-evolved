/**
 * Face liveness: the metric maths, the challenge lifecycle and the guards
 * that keep the old "photo matches" path closed.
 *
 * The geometry tests build landmark sets the way a camera would see them: a
 * symmetric frontal 68-point face (derived from a real detection) given a
 * plausible depth per landmark, rotated in 3D and projected with
 * perspective. "Real head turn" rotates that 3D face; "flat photo rotated"
 * squashes it onto a plane first (a printed photo / phone screen) and then
 * rotates the plane. The first must pass, the second must fail at every angle.
 *
 *     npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  faceGeometry, eyeAspectRatio, mouthAspectRatio, evaluateStep, evaluateSequence, classifyFrame,
  LIVENESS, type Pt, type FaceGeometry, type LivenessStep,
} from '../../src/utils/liveness/metrics';
import {
  pickSteps, challengeRejection, consumeChallenge, issueChallenge, recentFailures,
  MAX_FAILS_PER_WINDOW, CHALLENGE_TTL_MS, type ChallengeStore,
} from '../../src/utils/liveness/challenge';

const ROOT = path.join(__dirname, '../..');

// The audit log writes through Prisma, which is stubbed in unit tests.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../src/utils/auditLog').logAction = () => undefined;

// Frontal face, eye midpoint at the origin, inter-ocular distance 1 (x right, y down).
const FRONTAL: [number, number][] = [[-1.141, -0.144], [-1.123, 0.172], [-1.07, 0.468], [-1.022, 0.731], [-0.928, 1.032], [-0.764, 1.296], [-0.592, 1.502], [-0.35, 1.704], [0.0, 1.816], [0.35, 1.704], [0.592, 1.502], [0.764, 1.296], [0.928, 1.032], [1.022, 0.731], [1.07, 0.468], [1.123, 0.172], [1.141, -0.144], [-0.902, -0.295], [-0.769, -0.357], [-0.592, -0.363], [-0.43, -0.322], [-0.288, -0.256], [0.288, -0.256], [0.43, -0.322], [0.592, -0.363], [0.769, -0.357], [0.902, -0.295], [0.0, 0.109], [0.0, 0.374], [0.0, 0.606], [0.0, 0.784], [-0.198, 0.811], [-0.115, 0.851], [0.0, 0.886], [0.115, 0.851], [0.198, 0.811], [-0.685, -0.025], [-0.578, -0.068], [-0.44, -0.065], [-0.294, 0.034], [-0.423, 0.069], [-0.58, 0.057], [0.294, 0.034], [0.44, -0.065], [0.578, -0.068], [0.685, -0.025], [0.58, 0.057], [0.423, 0.069], [-0.419, 1.077], [-0.277, 1.062], [-0.097, 1.052], [0.0, 1.075], [0.097, 1.052], [0.277, 1.062], [0.419, 1.077], [0.278, 1.241], [0.139, 1.323], [0.0, 1.345], [-0.139, 1.323], [-0.278, 1.241], [-0.391, 1.077], [-0.123, 1.12], [0.0, 1.135], [0.123, 1.12], [0.391, 1.077], [0.123, 1.192], [0.0, 1.206], [-0.123, 1.192]];

// Depth toward the camera, relative to the nose tip, in inter-ocular units
// (nose tip ≈ 0.45–0.5 in front of the eyes, jaw corners ~1 behind it).
const DEPTH = (() => {
  const z: number[] = new Array(68).fill(-0.3);
  const jaw = [-0.95, -0.9, -0.8, -0.7, -0.6, -0.5, -0.4, -0.33, -0.3];
  for (let i = 0; i < 9; i++) { z[i] = jaw[i]; z[16 - i] = jaw[i]; }
  [-0.55, -0.47, -0.42, -0.4, -0.4].forEach((v, k) => { z[17 + k] = v; z[26 - k] = v; });
  Object.assign(z, { 27: -0.45, 28: -0.32, 29: -0.18, 30: 0, 31: -0.3, 32: -0.22, 33: -0.17, 34: -0.22, 35: -0.3 });
  for (let i = 36; i < 48; i++) z[i] = -0.52;
  Object.assign(z, { 36: -0.6, 45: -0.6, 39: -0.5, 42: -0.5, 48: -0.45, 54: -0.45, 60: -0.42, 64: -0.42 });
  return z;
})();

interface Cam { distance?: number; scale?: number; offset?: Pt; roll?: number }

/** Project 3D points (x right, y down, z toward camera) with a pinhole camera. */
function project(p3: [number, number, number][], { distance = 8, scale = 100, offset = { x: 320, y: 240 }, roll = 0 }: Cam = {}): Pt[] {
  return p3.map(([x, y, z]) => {
    const s = distance / (distance - z);
    const u = x * s, v = y * s;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    return { x: offset.x + scale * (u * cr - v * sr), y: offset.y + scale * (u * sr + v * cr) };
  });
}

/** A real head: 3D face rotated about a vertical axis through the middle of the head. */
function headTurn(deg: number, cam?: Cam, mouthOpen = 0): Pt[] {
  const th = deg * Math.PI / 180, zc = -1.2;
  const pts = FRONTAL.map(([x, y], i) => {
    let yy = y;
    if (mouthOpen && [55, 56, 57, 58, 59, 65, 66, 67].includes(i)) yy += mouthOpen;
    if (mouthOpen && i >= 5 && i <= 11) yy += mouthOpen * 0.8;
    const z = DEPTH[i];
    return [x * Math.cos(th) + (z - zc) * Math.sin(th), yy, zc + (-x * Math.sin(th) + (z - zc) * Math.cos(th))] as [number, number, number];
  });
  return project(pts, cam);
}

/** A flat picture of the frontal face, the picture itself turned by `deg` (and optionally tilted). */
function flatPhoto(deg: number, cam?: Cam, tiltDeg = 0, picture: Pt[] = project(FRONTAL.map(([x, y], i) => [x, y, DEPTH[i]]), { scale: 1, offset: { x: 0, y: 0 } })): Pt[] {
  const th = deg * Math.PI / 180, tl = tiltDeg * Math.PI / 180;
  return project(picture.map(({ x, y }) => {
    // rotate the plane about its vertical axis, then tilt about the horizontal one
    const x1 = x * Math.cos(th), z1 = -x * Math.sin(th);
    const y2 = y * Math.cos(tl) - z1 * Math.sin(tl), z2 = y * Math.sin(tl) + z1 * Math.cos(tl);
    return [x1, y2, z2] as [number, number, number];
  }), cam);
}

const geo = (pts: Pt[]) => faceGeometry(pts);

// ── metric primitives ──

test('eye aspect ratio: open vs closed eye', () => {
  const open = [{ x: 0, y: 0 }, { x: 1, y: -0.35 }, { x: 2, y: -0.35 }, { x: 3, y: 0 }, { x: 2, y: 0.35 }, { x: 1, y: 0.35 }];
  const closed = open.map(p => ({ x: p.x, y: p.y * 0.15 }));
  assert.ok(Math.abs(eyeAspectRatio(open) - 0.2333) < 0.001);
  assert.ok(eyeAspectRatio(closed) < 0.05);
  assert.equal(eyeAspectRatio(open.map(() => ({ x: 0, y: 0 }))), 0, 'degenerate eye is 0, not NaN');
});

test('mouth aspect ratio rises when the mouth opens and ignores scale', () => {
  const closed = geo(headTurn(0)).mar;
  const open = geo(headTurn(0, undefined, 0.4)).mar;
  assert.ok(closed < 0.12, `closed mouth MAR ${closed}`);
  assert.ok(open > 0.5, `open mouth MAR ${open}`);
  const small = geo(headTurn(0, { scale: 30 }, 0.4)).mar;
  assert.ok(Math.abs(small - open) < 0.01, 'MAR must not depend on face size');
  assert.equal(mouthAspectRatio(headTurn(0).map(() => ({ x: 1, y: 1 }))), 0);
});

test('a frontal face reads as zero yaw, symmetric, at any size, position or roll', () => {
  for (const cam of [{}, { scale: 40, offset: { x: 50, y: 70 } }, { roll: 0.35 }, { roll: -0.5, scale: 250 }]) {
    const g = geo(headTurn(0, cam));
    assert.ok(Math.abs(g.yaw) < 0.005, `yaw ${g.yaw} for ${JSON.stringify(cam)}`);
    assert.ok(Math.abs(g.asym) < 0.01, `asym ${g.asym}`);
  }
});

test('faceGeometry rejects malformed landmark sets', () => {
  assert.throws(() => faceGeometry([]));
  assert.throws(() => faceGeometry(new Array(68).fill({ x: 1, y: 1 })));
});

// ── real head vs flat photo ──

test('real head turn passes: left and right, near and far camera, with roll', () => {
  const neutral = geo(headTurn(0));
  for (const cam of [{}, { distance: 5 }, { distance: 14 }, { roll: 0.3 }]) {
    for (const deg of [25, 30, 40]) {
      const n = geo(headTurn(0, cam));
      const l = evaluateStep('turn_left', n, geo(headTurn(deg, cam)));
      const r = evaluateStep('turn_right', n, geo(headTurn(-deg, cam)));
      assert.ok(l.ok, `left ${deg}° ${JSON.stringify(cam)}: ${JSON.stringify(l)}`);
      assert.ok(r.ok, `right ${deg}° ${JSON.stringify(cam)}: ${JSON.stringify(r)}`);
      // The coupling a real head produces: the halves change more than the nose shift, opposite sign.
      assert.ok(l.yawDelta > 0 && l.asymDelta < -l.yawDelta, `coupling ${l.yawDelta} / ${l.asymDelta}`);
    }
  }
  // Barely moving is not a turn.
  assert.equal(evaluateStep('turn_left', neutral, geo(headTurn(5))).reason, 'not_enough');
  // A clear 35° turn is past the strong bar (no pixel confirmation needed); a modest one is weak.
  assert.ok(evaluateStep('turn_left', neutral, geo(headTurn(35))).strong);
  const modest = evaluateStep('turn_left', neutral, geo(headTurn(14)));
  assert.ok(modest.ok && !modest.strong, JSON.stringify(modest));
});

test('flat photo rotated or tilted in 3D fails at every angle and distance', () => {
  for (const distance of [3, 5, 8, 14]) {
    const n = geo(flatPhoto(0, { distance }));
    for (const deg of [-75, -60, -45, -30, -15, 15, 30, 45, 60, 75]) {
      for (const tilt of [0, 25]) {
        const g = geo(flatPhoto(deg, { distance }, tilt));
        for (const step of ['turn_left', 'turn_right'] as LivenessStep[]) {
          const r = evaluateStep(step, n, g);
          assert.ok(!r.ok, `flat photo at ${deg}° tilt ${tilt} d=${distance} passed ${step}: ${JSON.stringify(r)}`);
        }
        // Perspective alone moves it a little — never near what a turn needs —
        // except at absurd angles right at the lens, where the ratios leave
        // the range a head can produce at all (and are rejected for that).
        const moved = Math.abs(g.yaw - n.yaw);
        assert.ok(moved < LIVENESS.turnMinYaw * 0.75 || Math.abs(g.yaw) > LIVENESS.maxPlausibleYaw, `flat photo yaw moved ${moved} at ${deg}° d=${distance}`);
      }
    }
  }
});

test('a photo of an already-turned face, rotated as a card, still shows no nose motion', () => {
  const turnedPicture = headTurn(30, { scale: 1, offset: { x: 0, y: 0 } });
  const n = geo(flatPhoto(0, {}, 0, turnedPicture));
  for (const deg of [-50, -25, 25, 50]) {
    const g = geo(flatPhoto(deg, {}, 0, turnedPicture));
    assert.ok(!evaluateStep('turn_left', n, g).ok && !evaluateStep('turn_right', n, g).ok, `turned-face card at ${deg}° passed`);
  }
});

test('turning the wrong way is reported as such', () => {
  const n = geo(headTurn(0));
  assert.equal(evaluateStep('turn_left', n, geo(headTurn(-30))).reason, 'wrong_direction');
  assert.equal(evaluateStep('turn_right', n, geo(headTurn(30))).reason, 'wrong_direction');
});

test('anatomically impossible ratios never count as a turn', () => {
  const n = geo(headTurn(0));
  const r = evaluateStep('turn_right', n, { ...n, yaw: -1.5, asym: 0.6 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_3d_motion');
});

test('one 3D cue without the other is flagged as no 3D motion', () => {
  const n: FaceGeometry = { yaw: 0, asym: 0, mar: 0.1, ear: 0.3, iodRatio: 0.44, aspect: 1.1 };
  // halves unequal, nose unmoved — perspective on a tilted flat image
  assert.equal(evaluateStep('turn_left', n, { ...n, asym: -0.3 }).reason, 'no_3d_motion');
  // nose moved, outline didn't
  assert.equal(evaluateStep('turn_left', n, { ...n, yaw: 0.2 }).reason, 'no_3d_motion');
  // both, coupled: a turn
  assert.ok(evaluateStep('turn_left', n, { ...n, yaw: 0.2, asym: -0.35 }).strong);
});

test('mouth step needs a clearly open mouth relative to the start', () => {
  const n = geo(headTurn(0));
  assert.ok(evaluateStep('open_mouth', n, geo(headTurn(0, undefined, 0.4))).ok);
  assert.ok(!evaluateStep('open_mouth', n, geo(headTurn(0, undefined, 0.05))).ok);
  // Started with the mouth already open: opening "more" by a hair doesn't count.
  const openStart = geo(headTurn(0, undefined, 0.4));
  assert.ok(!evaluateStep('open_mouth', openStart, geo(headTurn(0, undefined, 0.42))).ok);
});

test('the client threshold is stricter than the server one', () => {
  const n = geo(headTurn(0));
  // find the smallest turn the server accepts; the client must still want more
  let deg = 1;
  while (!evaluateStep('turn_left', n, geo(headTurn(deg))).ok) deg++;
  const g = geo(headTurn(deg));
  const server = evaluateStep('turn_left', n, g), client = evaluateStep('turn_left', n, g, LIVENESS.clientFactor);
  assert.ok(server.ok && !client.ok, 'a frame just past the server bar must not yet satisfy the client');
  assert.equal(classifyFrame(n, geo(headTurn(-30))), 'turn_right');
  assert.equal(classifyFrame(n, n), null);
});

// ── sequences ──

const seqFrames = (steps: LivenessStep[], f: (s: LivenessStep) => Pt[]) =>
  [geo(headTurn(0)), ...steps.map(s => geo(f(s))), geo(headTurn(2))];
const perform = (s: LivenessStep) => s === 'turn_left' ? headTurn(30) : s === 'turn_right' ? headTurn(-30) : headTurn(0, undefined, 0.4);

test('a genuine sequence passes, in any issued order', () => {
  for (const steps of [['turn_left', 'open_mouth'], ['open_mouth', 'turn_right', 'turn_left'], ['turn_right', 'turn_left']] as LivenessStep[][]) {
    const r = evaluateSequence(steps, seqFrames(steps, perform));
    assert.ok(r.ok, `${steps}: ${JSON.stringify(r)}`);
  }
});

test('the same photo held up for every frame is a suspected photo', () => {
  const still = geo(headTurn(0));
  const r = evaluateSequence(['turn_left', 'open_mouth', 'turn_right'], [still, still, still, still, still]);
  assert.equal(r.reason, 'photo_suspected');
});

test('a photo waved around (rotated, tilted) is a suspected photo', () => {
  const frames = [geo(flatPhoto(0, { distance: 4 })), geo(flatPhoto(55, { distance: 4 })), geo(flatPhoto(-55, { distance: 4 }, 20)), geo(flatPhoto(5, { distance: 4 }))];
  const r = evaluateSequence(['turn_left', 'turn_right'], frames);
  assert.ok(!r.ok);
  assert.equal(r.reason, 'photo_suspected');
});

test('steps done in the wrong order are rejected as out of order', () => {
  const issued: LivenessStep[] = ['turn_right', 'turn_left'];
  const frames = [geo(headTurn(0)), geo(headTurn(30)), geo(headTurn(-30)), geo(headTurn(0))];
  assert.equal(evaluateSequence(issued, frames).reason, 'steps_out_of_order');
});

test('start must face the camera and end must come back', () => {
  const steps: LivenessStep[] = ['turn_left', 'open_mouth'];
  const startTurned = [geo(headTurn(-25)), geo(headTurn(30)), geo(headTurn(0, undefined, 0.4)), geo(headTurn(0))];
  assert.equal(evaluateSequence(steps, startTurned).reason, 'not_facing_camera');
  const endTurned = [geo(headTurn(0)), geo(headTurn(30)), geo(headTurn(0, undefined, 0.4)), geo(headTurn(30))];
  assert.equal(evaluateSequence(steps, endTurned).reason, 'end_not_neutral');
  assert.equal(evaluateSequence(steps, [geo(headTurn(0))]).ok, false, 'wrong frame count fails');
});

// ── the client copy ──

test('client and server use byte-identical metric code', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src/utils/liveness/metrics.ts'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, '../client/src/shared/livenessMetrics.ts'), 'utf8');
  assert.equal(client, server, 'client/src/shared/livenessMetrics.ts drifted from server/src/utils/liveness/metrics.ts — copy it over');
});

// ── challenges ──

test('challenges are 2–3 distinct steps and always include a head turn', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const s = pickSteps();
    assert.ok(s.length >= 2 && s.length <= 3, `length ${s.length}`);
    assert.equal(new Set(s).size, s.length, `duplicate step in ${s}`);
    assert.ok(s.some(x => x === 'turn_left' || x === 'turn_right'), `no turn in ${s}`);
    seen.add(s.join(','));
  }
  assert.ok(seen.size >= 8, `only ${seen.size} distinct challenges in 500 draws — not random enough`);
  // Even an RNG that always says 0 can't produce a turn-less challenge.
  assert.ok(pickSteps(() => 0).some(x => x !== 'open_mouth'));
});

/** In-memory stand-in for the Prisma table, with updateMany's compare-and-set semantics. */
function fakeStore() {
  const rows = new Map<string, any>();
  const matches = (r: any, where: any): boolean => Object.entries(where).every(([k, v]: [string, any]) => {
    if (v === null) return r[k] == null;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('gt' in v) return r[k] != null && r[k] > v.gt;
      if ('gte' in v) return r[k] != null && r[k] >= v.gte;
    }
    return r[k] === v;
  });
  const store: ChallengeStore & { rows: Map<string, any> } = {
    rows,
    faceLivenessChallenge: {
      async create({ data }: any) { const row = { usedAt: null, result: null, createdAt: new Date(), ...data }; rows.set(row.id, row); return row; },
      async findUnique({ where }: any) { return rows.get(where.id) ?? null; },
      async updateMany({ where, data }: any) { let count = 0; for (const r of rows.values()) if (matches(r, where)) { Object.assign(r, data); count++; } return { count }; },
      async update({ where, data }: any) { const r = rows.get(where.id); Object.assign(r, data); return r; },
      async count({ where }: any) { return [...rows.values()].filter(r => matches(r, where)).length; },
      async findFirst({ where, skip = 0 }: any) {
        return [...rows.values()].filter(r => matches(r, where)).sort((a, b) => b.usedAt - a.usedAt)[skip] ?? null;
      },
    },
  };
  return store;
}

test('challenge lifecycle: single use, expiry, user and purpose binding', async () => {
  const store = fakeStore();
  const t0 = new Date('2026-10-20T09:00:00Z');
  const c = await issueChallenge('org1', 'u1', 'CHECK_IN', t0, store);
  assert.match(c.challengeId, /^[A-Za-z0-9_-]{24}$/, 'id is a 144-bit random token');
  assert.equal(new Date(c.expiresAt).getTime() - t0.getTime(), CHALLENGE_TTL_MS);
  assert.equal(c.frames.count, c.steps.length + 2);

  const at = new Date(t0.getTime() + 10_000);
  // Wrong user / wrong purpose can't spend it — and don't burn it either.
  await assert.rejects(consumeChallenge(c.challengeId, 'u2', 'CHECK_IN', at, store), (e: any) => e.reason === 'challenge_invalid');
  await assert.rejects(consumeChallenge(c.challengeId, 'u1', 'ENROL', at, store), (e: any) => e.reason === 'challenge_invalid');
  await assert.rejects(consumeChallenge('nope-nope-nope-nope', 'u1', 'CHECK_IN', at, store), (e: any) => e.reason === 'challenge_invalid');

  const row = await consumeChallenge(c.challengeId, 'u1', 'CHECK_IN', at, store);
  assert.equal(row.userId, 'u1');
  await assert.rejects(consumeChallenge(c.challengeId, 'u1', 'CHECK_IN', at, store), (e: any) => e.reason === 'challenge_used' && e.code === 'LIVENESS_FAILED');

  // Expiry: recorded as a timeout failure (rate limit + audit).
  const late = await issueChallenge('org1', 'u1', 'CHECK_OUT', t0, store);
  const after = new Date(t0.getTime() + CHALLENGE_TTL_MS + 1);
  await assert.rejects(consumeChallenge(late.challengeId, 'u1', 'CHECK_OUT', after, store), (e: any) => e.reason === 'timeout');
  assert.equal(store.rows.get(late.challengeId).result, 'FAILED');
  assert.equal(store.rows.get(late.challengeId).failureReason, 'timeout');
});

test('challengeRejection is the single source of the reasons', () => {
  const now = new Date('2026-10-20T09:00:00Z');
  const row = { id: 'x', orgId: 'o', userId: 'u', purpose: 'CHECK_IN', steps: [], expiresAt: new Date(now.getTime() + 1000), usedAt: null, createdAt: now };
  assert.equal(challengeRejection(row, 'u', 'CHECK_IN', now), null);
  assert.equal(challengeRejection(null, 'u', 'CHECK_IN', now), 'challenge_invalid');
  assert.equal(challengeRejection({ ...row, usedAt: now }, 'u', 'CHECK_IN', now), 'challenge_used');
  assert.equal(challengeRejection({ ...row, expiresAt: now }, 'u', 'CHECK_IN', now), 'timeout');
});

test('5 failed face checks in 10 minutes block new challenges, then it clears', async () => {
  const store = fakeStore();
  const t0 = new Date('2026-10-20T09:00:00Z');
  for (let i = 0; i < MAX_FAILS_PER_WINDOW; i++) {
    const c = await issueChallenge('org1', 'u1', 'CHECK_IN', new Date(t0.getTime() + i * 1000), store);
    Object.assign(store.rows.get(c.challengeId), { usedAt: new Date(t0.getTime() + i * 1000 + 500), result: 'FAILED', failureReason: 'photo_suspected' });
  }
  const soon = new Date(t0.getTime() + 60_000);
  await assert.rejects(issueChallenge('org1', 'u1', 'CHECK_IN', soon, store), (e: any) => e.statusCode === 429 || e.status === 429 || /Too many failed/.test(e.message));
  assert.ok((await recentFailures('u1', soon, store)).retryAfterMin >= 1);
  // Someone else is unaffected.
  await issueChallenge('org1', 'u2', 'CHECK_IN', soon, store);
  // After the window the oldest failures age out.
  const later = new Date(t0.getTime() + 11 * 60_000);
  await issueChallenge('org1', 'u1', 'CHECK_IN', later, store);
});

// ── guards on the wiring ──

const code = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('liveness is on by default and the legacy descriptor is refused while it is', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
  assert.match(schema, /requireLiveness\s+Boolean\s+@default\(true\)/);
  const mig = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20261020100000_face_liveness/migration.sql'), 'utf8');
  assert.match(mig, /"require_liveness" BOOLEAN NOT NULL DEFAULT true/);

  const c = code('src/modules/hr/attendance/attendance.controller.ts');
  const resolve = c.split('async function resolveFaceSignal')[1].split('\nasync function ')[0];
  assert.match(resolve, /if \(policy\.requireLiveness\) return \{ status: 'not_provided', legacyBlocked: true \}/);
  assert.match(c, /face\.legacyBlocked \? appUpdateRequiredError\(\)/);
  // Enrolment can't take the legacy path either while liveness is required.
  const enrol = c.split('async function enrolmentFromRequest')[1].split('\nexport async function')[0];
  assert.match(enrol, /if \(policy\.requireLiveness\) throw appUpdateRequiredError\(\)/);
  // The stored face comes from the server's analysis, never the client's numbers.
  assert.match(enrol, /descriptors: pass\.descriptors/);
  // Evidence on the record is a verified frame; the client selfie only on the legacy path.
  assert.match(c, /v\.faceEvidence \?\? \(policy\.requireLiveness \? null : selfie \?\? null\)/);
});

test('challenge routes are open to every staff role; attempt review is for managers', () => {
  const r = code('src/modules/hr/attendance/attendance.routes.ts');
  assert.match(r, /post\('\/face\/challenge',\s*requireRole\(\.\.\.ALL_USERS\),\s*challengeLimiter/);
  assert.match(r, /get\('\/face\/attempts',\s*requireHrManager\('attendance'\)/); // HR managers (utils/hrAccess.ts)
  const c = code('src/modules/hr/attendance/attendance.controller.ts');
  for (const fn of ['listFaceAttempts', 'getFaceAttempt']) {
    const body = c.split(`async function ${fn}`)[1].split('\nexport ')[0];
    assert.match(body, /orgId: req\.user!\.orgId/, `${fn} must be org-scoped`);
  }
});

test('the client answers challenges with frames and never sends its own descriptors', () => {
  const page = code('../client/src/modules/hr/AttendancePage.tsx');
  assert.ok(!/faceDescriptor|descriptors:/.test(page), 'AttendancePage still posts client-computed descriptors');
  assert.match(page, /liveness: answer/);
  assert.match(page, /enrolChallengeId/);
  const modal = code('../client/src/shared/components/FaceCaptureModal.tsx');
  assert.match(modal, /\/hr\/attendance\/face\/challenge/);
  // Only the shared metric code decides on the client — the same file the server uses.
  assert.match(modal, /from '\.\.\/livenessMetrics'/);
});
