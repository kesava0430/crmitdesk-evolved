import { useParams, Link } from 'react-router-dom';
import { Layers, Settings2, Zap } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCustomModules, useCustomModule } from '../api/customModules';
import { CustomModuleRecordsTab } from '../shared/components/CustomModuleRecords';
import { PageHeader, Spinner, EmptyState, Badge } from '../shared/components';

// Same roles allowed to see the "Custom Modules" builder link in
// AppLayout.tsx's NAV_SECTIONS — kept in sync manually since routeAccess.ts
// only derives guards from NAV_SECTIONS' static entries, not this dynamic
// per-module route (see AppLayout.tsx's module-nav-injection comment).
const MODULE_MANAGER_ROLES = ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'];

/**
 * Nav-linked, records-only view of one custom module — reached via the
 * dynamic per-module sidebar entries AppLayout.tsx injects under "Modules".
 * Deliberately thinner than CustomModulesPage.tsx (the builder): no field
 * editor, no sync config, just the day-to-day "look at / add / edit records"
 * view every staff role can already use as of ALL_STAFF-gated routes on
 * /api/custom-modules/:id/records. Managers get a link back to the full
 * builder for field/sync changes.
 */
export default function CustomModuleViewPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const { data: modules, isLoading: listLoading } = useCustomModules();
  const found = modules?.find((m: any) => m.slug === slug);
  const { data: module_, isLoading: detailLoading } = useCustomModule(found?.id);

  const canManage = !!user?.role && MODULE_MANAGER_ROLES.includes(user.role);

  if (listLoading || (found && detailLoading)) {
    return <div className="p-6"><Spinner /></div>;
  }

  if (!found || !module_) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Layers size={24} />}
          title="Module not found"
          description="This custom module doesn't exist, or has been deleted."
        />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 h-full flex flex-col animate-slide-up">
      <PageHeader
        title={module_.name}
        subtitle={module_.description || undefined}
        actions={
          <>
            {found.syncConfig?.isActive && (
              <Badge variant="indigo"><Zap size={11} /> Sync enabled</Badge>
            )}
            {canManage && (
              // Stays a real <Link> so routing (and cmd-click) keeps working —
              // Button renders a <button> and cannot carry the route.
              <Link
                to={`/custom-modules?module=${module_.id}`}
                className="inline-flex items-center gap-1.5 px-3 h-ctl-sm border border-line rounded-btn text-xs font-medium text-fg bg-surface shadow-ui-sm hover:bg-surface-hover hover:border-line-strong transition-colors"
              >
                <Settings2 size={13} /> Manage fields &amp; sync
              </Link>
            )}
          </>
        }
      />
      <div className="mt-4 flex-1 min-h-0 overflow-y-auto">
        <CustomModuleRecordsTab module_={module_} canDelete={canManage} />
      </div>
    </div>
  );
}
