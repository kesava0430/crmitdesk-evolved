import { PackageX } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * Shown instead of a page whose area / module the platform operator has
 * switched off for this org (see shared/modules.ts). The pages themselves
 * would only render a wall of 402s.
 */
export function ModuleNotEnabled({ name, area }: { name?: string; area?: string }) {
  const what = area && name && area !== name ? `${name} (part of ${area})` : (name ?? area ?? 'This module');
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-20 sm:py-28" data-testid="module-not-enabled">
      <PackageX className="w-10 h-10 text-fg-subtle mb-3" />
      <h2 className="text-lg font-semibold text-fg">This module isn't enabled for your organisation</h2>
      <p className="text-sm text-fg-muted mt-1 max-w-sm">
        {what} is switched off for your organisation. Contact your administrator if you need it.
      </p>
      <Link to="/dashboard" className="mt-5 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300">
        Back to Dashboard
      </Link>
    </div>
  );
}
