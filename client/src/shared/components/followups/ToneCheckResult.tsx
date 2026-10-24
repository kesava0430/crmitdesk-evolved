import { Alert } from '../Alert';

/**
 * Tone check result.
 *
 * The server returns { tone, score, issues[], suggestions[], approved }
 * (see `checkEmailTone` in server/src/utils/ai.ts). This used to be dumped
 * through JSON.stringify, so the user was shown raw braces and quotes; the
 * fields are rendered properly now. A plain string is still handled, since an
 * older/failed response can come back that way.
 */
export function ToneCheckResult({ data }: { data: any }) {
  if (typeof data === 'string') {
    return (
      <Alert tone="accent" title="Tone Analysis">
        <p className="text-xs leading-relaxed">{data}</p>
      </Alert>
    );
  }

  /* The server now fails CLOSED: when AI is unavailable or the reply was
     malformed it returns checked:false rather than approved:true. Surfacing
     that distinction matters — an unchecked email must not look like one that
     passed review. Older servers omit `checked`; treat that as checked. */
  if (data?.checked === false) {
    return (
      <Alert tone="warning" title="Tone not checked">
        <p className="text-xs leading-relaxed">
          The tone check could not run, so this email has not been reviewed. Check that an AI
          provider is configured, then try again.
        </p>
      </Alert>
    );
  }

  const tone: string | undefined = data?.tone;
  const score: number | undefined = typeof data?.score === 'number' ? data.score : undefined;
  const issues: string[] = Array.isArray(data?.issues) ? data.issues : [];
  const suggestions: string[] = Array.isArray(data?.suggestions) ? data.suggestions : [];
  const alertTone = score == null ? 'accent' : score >= 75 ? 'success' : score >= 50 ? 'warning' : 'danger';

  return (
    <Alert tone={alertTone} title="Tone Analysis">
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        {tone && <span className="text-xs font-semibold capitalize">{tone}</span>}
        {score != null && <span className="text-xs opacity-80">{score}/100</span>}
        {data?.approved === false && <span className="text-xs font-medium">Needs a rewrite</span>}
      </div>
      {issues.length > 0 && (
        <div className="mb-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider opacity-80 mb-0.5">Issues</p>
          <ul className="space-y-1">
            {issues.map((issue, i) => (
              <li key={i} className="text-xs flex items-start gap-1.5">
                <span className="opacity-60 mt-0.5 flex-shrink-0">&#8226;</span>{issue}
              </li>
            ))}
          </ul>
        </div>
      )}
      {suggestions.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider opacity-80 mb-0.5">Suggestions</p>
          <ul className="space-y-1">
            {suggestions.map((s, i) => (
              <li key={i} className="text-xs flex items-start gap-1.5">
                <span className="opacity-60 mt-0.5 flex-shrink-0">&#8226;</span>{s}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!tone && score == null && issues.length === 0 && suggestions.length === 0 && (
        <p className="text-xs leading-relaxed">No tone issues were reported.</p>
      )}
    </Alert>
  );
}

