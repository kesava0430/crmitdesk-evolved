import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useLicense } from '../../api/billing';
import { useAuth } from '../../contexts/AuthContext';
import { can } from '../permissions';
import { featureLabel } from '../licenseFeatures';
import { Alert } from './Alert';

/**
 * Upgrade state for a page whose feature the org's licence doesn't include
 * (GET /billing/entitlements). The server already enforces it with a 402 —
 * this just says so up front instead of leaving a page of failed requests.
 * Renders nothing while loading or when the feature is included.
 */
export function PlanFeatureNotice({ feature, what }: { feature: string; what?: string }) {
  const { user } = useAuth();
  const { data: lic } = useLicense(!!user?.role);
  if (!lic || lic.features.includes(feature)) return null;
  const name = what ?? featureLabel(feature);
  return (
    <div data-testid={`plan-feature-notice-${feature}`}>
      <Alert
        tone="warning"
        icon={<Lock size={16} />}
        title={`${name} isn't included in your plan`}
        actions={can.readBilling(user?.role) ? <Link to="/billing" className="font-semibold underline whitespace-nowrap">See plans</Link> : undefined}
      >
        {lic.access === 'lapsed'
          ? `${lic.reason ?? 'Your paid licence is inactive.'} Anything you already set up keeps working; restore payment to make changes.`
          : can.readBilling(user?.role)
            ? 'Existing data stays visible where possible. Upgrade, or add it to a custom licence, to use it fully.'
            : 'Existing data stays visible where possible. Ask your Super Admin to upgrade the plan.'}
      </Alert>
    </div>
  );
}
