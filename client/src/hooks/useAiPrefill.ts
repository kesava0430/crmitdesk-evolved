import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Reads the `aiPrefill` field payload the AI Command Bar attaches to its
 * navigation (see shared/components/AiCommandBar.tsx navigateToEntity) and
 * hands it to the caller once, then scrubs it from router state so a later
 * refresh/back-navigation to the same URL doesn't re-open the create modal.
 *
 * This used to be the missing link in the "create a ticket/contact/lead/
 * deal/article via AI command" flow: the command bar always navigated here
 * with the parsed fields in `location.state`, but nothing on any of these
 * pages ever read it back out, so the AI's "Go Create X" button just landed
 * on the plain list page and did nothing.
 */
export function useAiPrefill<T = Record<string, any>>(): T | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [prefill, setPrefill] = useState<T | null>(null);

  useEffect(() => {
    const state = location.state as { aiPrefill?: T } | null;
    if (state?.aiPrefill) {
      setPrefill(state.aiPrefill);
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return prefill;
}
