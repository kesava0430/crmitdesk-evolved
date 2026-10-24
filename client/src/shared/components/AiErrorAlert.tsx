/**
 * How an AI failure is shown inline. A provider rate limit is not an error
 * the user caused: it reads as a calm warning with the wait the server gave,
 * and — for a per-minute limit — a "Try again" button that unlocks when the
 * wait is over. A daily limit offers no quick retry (it resets in hours).
 */
import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Alert } from './Alert';
import { Button } from './Button';
import type { AiErrorInfo } from '../ai/aiError';

export function AiErrorAlert({ error, onRetry, onDismiss, className }: {
  error: AiErrorInfo | null; onRetry?: () => void; onDismiss?: () => void; className?: string;
}) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!error?.rateLimited || error.window === 'day' || !error.retryAfterSec) { setLeft(0); return; }
    const until = Date.now() + error.retryAfterSec * 1000;
    setLeft(error.retryAfterSec);
    const t = window.setInterval(() => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(s);
      if (!s) window.clearInterval(t);
    }, 1000);
    return () => window.clearInterval(t);
  }, [error]);
  if (!error) return null;
  if (!error.rateLimited) return <Alert tone="danger" onDismiss={onDismiss} className={className}>{error.message}</Alert>;
  const canRetry = !!onRetry && error.window !== 'day';
  return (
    <Alert
      tone="warning"
      title={error.window === 'day' ? 'Daily AI allowance used up' : 'The AI is busy'}
      onDismiss={onDismiss}
      className={className}
      actions={canRetry ? (
        <Button size="xs" variant="secondary" icon={<RotateCcw size={12} />} disabled={left > 0} onClick={onRetry} data-testid="ai-retry">
          {left > 0 ? `Try again in ${left}s` : 'Try again'}
        </Button>
      ) : undefined}
    >
      <span data-testid="ai-rate-limit-message">{error.message}</span>
    </Alert>
  );
}
