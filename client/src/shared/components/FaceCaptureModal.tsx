import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, CheckCircle2, Laugh, RotateCcw, ScanFace } from 'lucide-react';
import { Modal, Button, Alert } from './index';
import { api } from '../../api/client';
import { openCamera, stopStream, loadFaceApi, trackFace, grabFrame, encodeFrame, type FaceBox } from '../face';
import {
  faceGeometry, evaluateStep, classifyFrame, descriptorDistance, LIVENESS,
  type FaceGeometry, type LivenessStep,
} from '../livenessMetrics';

/** What the server needs to verify a liveness check (it re-analyses the frames itself). */
export interface LivenessAnswer { challengeId: string; frames: string[] }
export type LivenessPurpose = 'check_in' | 'check_out' | 'enrol';

interface Challenge { challengeId: string; steps: LivenessStep[]; expiresAt: string; frames: { count: number; maxEdge: number } }

interface Props {
  open: boolean;
  onClose: () => void;
  /** 'enrol' stores a new face; 'verify' compares with the enrolled one. */
  mode: 'enrol' | 'verify';
  /** What the server-issued challenge is bound to. */
  purpose: LivenessPurpose;
  onCaptured: (answer: LivenessAnswer) => Promise<void> | void;
  title?: string;
  subtitle?: string;
  /**
   * Opt in to an explicit confirmation step. Without it the modal submits the
   * moment the challenge is done, which is right for check-in — nobody wants
   * an extra click between their face and the clock. Re-enrolment is the
   * opposite: it starts an approval someone else has to action, so the
   * employee reviews what was captured and presses this button by name.
   */
  submitLabel?: string;
}

const STEP_COPY: Record<LivenessStep, { title: string; short: string; hint: string }> = {
  turn_left: { title: 'Turn your head to the left', short: 'Turn left', hint: 'Keep turning slowly until the bar fills.' },
  turn_right: { title: 'Turn your head to the right', short: 'Turn right', hint: 'Keep turning slowly until the bar fills.' },
  open_mouth: { title: 'Open your mouth wide', short: 'Open mouth', hint: 'Like saying “aah” — hold it for a moment.' },
};

function StepIcon({ step, size = 18 }: { step: LivenessStep; size?: number }) {
  // The preview is mirrored, so "your left" is the left of the screen.
  if (step === 'turn_left') return <ArrowLeft size={size} />;
  if (step === 'turn_right') return <ArrowRight size={size} />;
  return <Laugh size={size} />;
}

type ClientFailure = 'timeout' | 'face_lost' | 'multiple_faces' | 'face_changed' | 'wrong_action';
const FAILURE_COPY: Record<ClientFailure, string> = {
  timeout: 'Time ran out — the check has to be finished within about a minute.',
  face_lost: 'We lost sight of your face — keep it inside the oval the whole time.',
  multiple_faces: 'More than one face came into view — make sure only you are in the frame.',
  face_changed: 'The face in view changed during the check.',
  wrong_action: "That wasn't the movement asked for — follow the prompt on screen.",
};
const GENERAL_FAIL = "Liveness check failed — make sure you're in good light and follow the prompts.";

/** Total time the client allows itself; the server's challenge lives ~90 s and the upload needs a moment. */
const CLIENT_BUDGET_MS = 80_000;
const STEP_TIMEOUT_MS = 20_000;
/** How long a turn may sit between the server's bar and the "clear" bar before we take the best frame. */
const SETTLE_MS = 1_500;

type Stage = { kind: 'neutral' } | { kind: 'step'; index: number } | { kind: 'return'; next: number };

/**
 * Guided liveness capture. The server issues a random sequence of movements;
 * this walks the person through them with live landmark tracking, keeps one
 * small frame at the start, at the peak of each movement and at the end, and
 * hands them over. The tracking here is guidance only — the server repeats
 * every check on the frames itself (server/src/utils/liveness).
 */
export function FaceCaptureModal({ open, onClose, mode, purpose, onCaptured, title, subtitle, submitLabel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<'loading' | 'detecting' | 'review' | 'submitting' | 'done' | 'error'>('loading');
  const [error, setError] = useState<{ title: string; detail?: string; retry: boolean } | null>(null);
  const [hint, setHint] = useState('Starting camera…');
  const [steps, setSteps] = useState<LivenessStep[]>([]);
  const [stage, setStage] = useState<Stage>({ kind: 'neutral' });
  const [progress, setProgress] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [box, setBox] = useState<FaceBox | null>(null);
  const [review, setReview] = useState<LivenessAnswer | null>(null);
  const [runId, setRunId] = useState(0);

  function showServerError(err: any) {
    const data = err?.response?.data;
    const status = err?.response?.status;
    const message = data?.error || err?.message || 'Verification failed.';
    if (data?.code === 'LIVENESS_FAILED') setError({ title: message, retry: true });
    else if (status === 429) setError({ title: message, retry: false });
    else setError({ title: message, retry: status !== 426 && status !== 403 });
    setPhase('error');
  }

  async function submit(answer: LivenessAnswer) {
    setPhase('submitting'); setHint('Verifying…'); setError(null);
    try {
      await onCaptured(answer);
      setPhase('done');
    } catch (err: any) {
      showServerError(err);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let challengeId = '';
    setError(null); setPhase('loading'); setHint('Loading face model…'); setReview(null);
    setStage({ kind: 'neutral' }); setProgress(0); setSteps([]); setSecondsLeft(null); setBox(null);

    const fail = (reason: ClientFailure) => {
      if (cancelled) return;
      cancelled = true;
      stopStream(streamRef.current); streamRef.current = null;
      // Audit trail + rate limit only; the server never lets this pass anything.
      if (challengeId) api.post(`/hr/attendance/face/challenge/${challengeId}/abandon`, { reason }, { _silent: true } as any).catch(() => undefined);
      setError({ title: GENERAL_FAIL, detail: FAILURE_COPY[reason], retry: true });
      setPhase('error');
    };

    (async () => {
      try {
        await loadFaceApi();
        if (cancelled) return;
        const { data: challenge } = await api.post<Challenge>('/hr/attendance/face/challenge', { purpose }, { _silent: true } as any);
        if (cancelled) return;
        challengeId = challenge.challengeId;
        const chSteps = challenge.steps;
        setSteps(chSteps);

        setHint('Starting camera…');
        const stream = await openCamera();
        if (cancelled) { stopStream(stream); return; }
        streamRef.current = stream;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        setPhase('detecting');
        setHint('Look straight at the camera.');

        const startedAt = Date.now();
        const deadline = startedAt + CLIENT_BUDGET_MS;
        const frames: string[] = [];
        const canvas = document.createElement('canvas');
        let st: Stage = { kind: 'neutral' };
        let baseline: FaceGeometry | null = null;
        let baseDesc: number[] | null = null;
        let stable = 0, frameNo = 0, missingSince = 0, stageStartedAt = Date.now(), firstOkAt = 0;
        let best: { score: number; frame: string } | null = null;
        const go = (next: Stage) => { st = next; stable = 0; stageStartedAt = Date.now(); firstOkAt = 0; best = null; setStage(next); setProgress(0); };

        const finish = (answer: LivenessAnswer) => {
          cancelled = true;
          stopStream(streamRef.current); streamRef.current = null;
          setBox(null);
          if (submitLabel) { setReview(answer); setPhase('review'); return; }
          submit(answer);
        };

        // Any error inside a tick must surface — an exception in an async
        // setTimeout callback would otherwise just stop the loop silently.
        const loop = () => { tick().catch((err: any) => {
          if (cancelled) return;
          cancelled = true;
          stopStream(streamRef.current); streamRef.current = null;
          if (challengeId) api.post(`/hr/attendance/face/challenge/${challengeId}/abandon`, { reason: 'error' }, { _silent: true } as any).catch(() => undefined);
          setError({ title: 'Face detection stopped unexpectedly — please try again.', detail: err?.message, retry: true });
          setPhase('error');
        }); };
        const tick = async () => {
          if (cancelled) return;
          const v = videoRef.current;
          if (!v || v.readyState < 2) { setTimeout(loop, 100); return; }
          const now = Date.now();
          setSecondsLeft(Math.max(0, Math.ceil((deadline - now) / 1000)));
          if (now > deadline) return fail('timeout');
          frameNo++;
          const frame = grabFrame(v, canvas);
          // Descriptor (the expensive net) only to lock the baseline and then
          // every few frames to make sure the same face stays in view.
          const wantDescriptor = st.kind === 'neutral' ? stable >= 3 : frameNo % 6 === 0;
          const t = await trackFace(frame, wantDescriptor);
          if (cancelled) return;

          if (t.status !== 'ok') {
            setBox(t.status === 'small' ? t.box : null);
            if (t.status === 'multiple' && st.kind !== 'neutral') return fail('multiple_faces');
            if (st.kind !== 'neutral') {
              missingSince = missingSince || now;
              if (now - missingSince > 2000) return fail('face_lost');
            }
            stable = 0;
            setHint(t.status === 'multiple' ? 'More than one face in view — make sure only you are visible.'
              : t.status === 'small' ? 'Move a little closer to the camera.'
              : 'No face detected — move into the oval and face the camera.');
            setTimeout(loop, 80);
            return;
          }
          missingSince = 0;
          setBox(t.box);
          const g = faceGeometry(t.landmarks);
          if (t.descriptor && baseDesc && descriptorDistance(t.descriptor, baseDesc) > LIVENESS.sameFaceMaxDistance) return fail('face_changed');

          if (st.kind === 'neutral') {
            const straight = Math.abs(g.yaw) <= LIVENESS.neutralMaxYaw * 0.7 && g.mar < LIVENESS.mouthMinMar * 0.8;
            stable = straight ? stable + 1 : 0;
            setHint(straight ? 'Hold still…' : 'Look straight at the camera, mouth closed.');
            if (stable >= 4 && t.descriptor) {
              baseline = g; baseDesc = t.descriptor;
              frames.push(encodeFrame(frame));
              go({ kind: 'step', index: 0 });
              setHint(STEP_COPY[chSteps[0]].hint);
            }
          } else if (st.kind === 'step') {
            const step = chSteps[st.index];
            const r = evaluateStep(step, baseline!, g, LIVENESS.clientFactor);
            const dir = step === 'turn_left' ? 1 : -1;
            const amount = step === 'open_mouth'
              ? r.marDelta / (LIVENESS.mouthMinMarDelta * LIVENESS.clientFactor)
              : (r.yawDelta * dir) / (LIVENESS.turnStrongYaw * LIVENESS.clientFactor);
            setProgress(Math.max(0, Math.min(1, amount)));
            // A clear movement other than the one asked for (e.g. right when
            // asked left) fails the attempt: a video that cycles through every
            // movement must not be able to answer any challenge.
            const shown = classifyFrame(baseline!, g, LIVENESS.clientFactor);
            if (shown && shown !== step && shown !== 'open_mouth') return fail('wrong_action');
            if (r.ok) {
              const score = step === 'open_mouth' ? g.mar : r.yawDelta * dir;
              if (!best || score > best.score) best = { score, frame: encodeFrame(frame) };
              firstOkAt = firstOkAt || now;
              if (r.strong || now - firstOkAt > SETTLE_MS) {
                frames.push(best.frame);
                const next = st.index + 1;
                go({ kind: 'return', next });
                setHint('Good — now look straight at the camera again.');
              } else {
                setHint(step === 'open_mouth' ? 'A little wider…' : 'A little further…');
              }
            } else if (now - stageStartedAt > STEP_TIMEOUT_MS) {
              return fail('timeout');
            }
          } else {
            const back = Math.abs(g.yaw - baseline!.yaw) <= 0.06 && g.mar <= baseline!.mar + 0.12;
            stable = back ? stable + 1 : 0;
            if (now - stageStartedAt > STEP_TIMEOUT_MS) return fail('timeout');
            if (stable >= 2) {
              const next = st.next;   // read before go() replaces st
              if (next < chSteps.length) {
                go({ kind: 'step', index: next });
                setHint(STEP_COPY[chSteps[next]].hint);
              } else {
                frames.push(encodeFrame(frame));
                setStage({ kind: 'return', next: chSteps.length });
                return finish({ challengeId, frames });
              }
            }
          }
          setTimeout(loop, 40);
        };
        loop();
      } catch (err: any) {
        if (cancelled) return;
        if (err?.response) { showServerError(err); return; }
        setError({ title: err?.message || 'Could not start face capture.', retry: true });
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      stopStream(streamRef.current); streamRef.current = null;
    };
  }, [open, purpose, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const current: LivenessStep | null = phase === 'detecting' && stage.kind === 'step' ? steps[stage.index] : null;
  const doneCount = stage.kind === 'step' ? stage.index : stage.kind === 'return' ? stage.next : 0;
  const instruction = phase !== 'detecting' ? null
    : stage.kind === 'neutral' ? { icon: <ScanFace size={18} />, title: 'Look straight at the camera' }
    : stage.kind === 'return' ? { icon: <ScanFace size={18} />, title: 'Now look straight again' }
    : { icon: <StepIcon step={current!} />, title: STEP_COPY[current!].title };
  const showFrames = submitLabel && review && (phase === 'review' || phase === 'submitting' || phase === 'done');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? (mode === 'enrol' ? 'Enrol your face' : 'Face verification')}
      subtitle={subtitle ?? (mode === 'enrol'
        ? "Follow the prompts on screen — a few quick head movements prove it's really you, not a photo. A numeric face signature and one reference photo are stored for matching. To remove or replace them, ask HR."
        : "Follow the prompts on screen — a few quick head movements prove it's really you, not a photo.")}
      icon={<ScanFace size={16} />}
      size="md"
      footer={
        phase === 'done' ? <Button icon={<CheckCircle2 size={14} />} onClick={onClose}>Done</Button>
        : phase === 'error' ? (
          <div className="flex gap-2 flex-wrap justify-end">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            {error?.retry && <Button icon={<RotateCcw size={14} />} onClick={() => setRunId(n => n + 1)} data-testid="face-retry">Try again</Button>}
          </div>
        )
        : phase === 'review' ? (
          <div className="flex gap-2 flex-wrap justify-end">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button icon={<CheckCircle2 size={14} />} onClick={() => review && submit(review)}>{submitLabel}</Button>
          </div>
        )
        : phase === 'submitting' && submitLabel ? <Button loading disabled>{submitLabel}</Button>
        : <Button variant="ghost" onClick={onClose}>Cancel</Button>
      }
    >
      {/* text-left: the modal renders inside the (centred) attendance card. */}
      <div className="space-y-3 text-left">
        {/* Once the frames are in, the dead video feed has nothing left to
            show — the captured frames are what the employee is confirming, so
            they stay on screen through submission and the result. */}
        {showFrames ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {review!.frames.map((f, i) => (
                <img key={i} src={f} alt={`Captured frame ${i + 1}`} className="w-full aspect-square rounded-lg object-cover -scale-x-100 border border-line" />
              ))}
            </div>
            {phase === 'done' ? (
              <Alert tone="success">Submitted for verification. Your current Face ID stays active until a Super Admin reviews it.</Alert>
            ) : (
              <p className="text-[12.5px] text-fg-muted">
                Liveness check complete. These frames go to a Super Admin for review; your current Face ID stays active until then.
              </p>
            )}
          </div>
        ) : (
          // Hidden (not unmounted) after a failure: the dead feed would push
          // the reason below the fold on a phone, and a retry reuses the element.
          <div className={`relative rounded-xl overflow-hidden bg-black aspect-[3/4] sm:aspect-[4/3] max-h-[50vh] sm:max-h-[360px] mx-auto w-full ${phase === 'error' ? 'hidden' : ''}`} data-testid="face-stage">
            <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover -scale-x-100" data-testid="face-video" />

            {/* Oval guide: everything outside it is dimmed. Turns green while a face is tracked. */}
            {phase === 'detecting' && (
              <div
                aria-hidden="true"
                className={`absolute left-1/2 top-[48%] -translate-x-1/2 -translate-y-1/2 h-[74%] aspect-[3/4] rounded-[50%] border-2 transition-colors shadow-[0_0_0_9999px_rgba(0,0,0,0.38)] ${box ? 'border-success' : 'border-white/70'}`}
              />
            )}

            {instruction && (
              <div className="absolute inset-x-0 top-0 px-3 pt-3 pb-10 bg-gradient-to-b from-black/80 via-black/45 to-transparent text-white" aria-live="polite">
                {/* Prompt + live feedback live on the video itself: on a phone
                    anything below it can fall under the fold of the sheet. */}
                <div className="flex items-start gap-2 min-w-0">
                  <span className="shrink-0 w-8 h-8 rounded-full bg-white/15 flex items-center justify-center">{instruction.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] sm:text-base font-semibold leading-tight" data-testid="face-instruction">{instruction.title}</p>
                    <p className="text-[12px] text-white/85 mt-0.5 leading-snug" data-testid="face-hint">{hint}</p>
                  </div>
                  {secondsLeft != null && (
                    <span className="shrink-0 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-medium tabular-nums" aria-label={`${secondsLeft} seconds left`}>{secondsLeft}s</span>
                  )}
                </div>
              </div>
            )}

            {/* Big direction cue beside the oval for head turns. */}
            {current && current !== 'open_mouth' && (
              <div aria-hidden="true" className={`absolute top-1/2 -translate-y-1/2 ${current === 'turn_left' ? 'left-2' : 'right-2'} text-white/90 animate-pulse`}>
                <StepIcon step={current} size={34} />
              </div>
            )}

            {current && (
              <div className="absolute inset-x-4 bottom-4">
                <div className="h-2 rounded-full bg-white/25 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Movement progress">
                  <div className="h-full rounded-full bg-success transition-[width] duration-100" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              </div>
            )}

            {(phase === 'loading' || phase === 'submitting') && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-white text-sm gap-2 px-4 text-center">
                <Camera size={16} className="animate-pulse shrink-0" /> {hint}
              </div>
            )}
            {phase === 'done' && (
              <div className="absolute inset-0 flex items-center justify-center bg-success/75 text-white text-sm gap-2">
                <CheckCircle2 size={18} /> {submitLabel ? 'Submitted' : mode === 'enrol' ? 'Face enrolled' : 'Verified'}
              </div>
            )}
          </div>
        )}

        {/* The sequence the server asked for, so the person knows what's coming. */}
        {steps.length > 0 && (phase === 'detecting' || phase === 'submitting') && (
          <ol className="flex flex-wrap gap-1.5" aria-label="Steps" data-testid="face-steps">
            {steps.map((s, i) => {
              const done = i < doneCount || phase === 'submitting';
              const active = !done && stage.kind === 'step' && stage.index === i;
              return (
                <li
                  key={i}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${
                    done ? 'border-success/30 bg-success-soft text-success-fg'
                    : active ? 'border-accent/40 bg-accent-soft text-accent-soft-fg'
                    : 'border-line text-fg-muted'}`}
                >
                  {done ? <CheckCircle2 size={13} /> : <StepIcon step={s} size={13} />}
                  {i + 1}. {STEP_COPY[s].short}
                </li>
              );
            })}
          </ol>
        )}

        {phase === 'error' && error && (
          <Alert tone="danger" title={error.title}>
            {error.detail && <span className="block" data-testid="face-error-detail">{error.detail}</span>}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
