import { useParams, Link } from 'react-router-dom';
import { Layers, Settings2, Zap } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCustomModules, useCustomModule } from '../api/customModules';
import { CustomModuleRecordsTab } from '../shared/components/CustomModuleRecords';
import { PageHeader, PageBody, SkeletonTable, EmptyState, Badge, AccessDenied } from '../shared/components';
import { can } from '../shared/permissions';

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
  /* Both reads behind this page are ALL_STAFF. The sidebar never injects these
     links for an EMPLOYEE, but the route is still reachable by URL — and until
     now that meant two guaranteed 403s and a "module not found" screen that
     misdescribed why. */
  const canRead = can.readStaffRecords(user?.role);
  const { data: modules, isLoading: listLoading } = useCustomModules(canRead);
  const found = modules?.find((m: any) => m.slug === slug);
  const { data: module_, isLoading: detailLoading } = useCustomModule(found?.id, canRead);

  // Same roles that get the "Custom Modules" builder link in AppLayout.tsx's
  // NAV_SECTIONS — the manager group, read off the shared capability table
  // rather than a local copy of the role names.
  const canManage = can.manageCustomFields(user?.role);

  if (!canRead) return <AccessDenied />;

  if (listLoading || (found && detailLoading)) {
    return (
      <PageBody>
        <SkeletonTable rows={6} />
      </PageBody>
    );
  }

  if (!found || !module_) {
    return (
      <PageBody>
        <EmptyState
          icon={<Layers size={24} />}
          title="Module not found"
          description="This custom module doesn't exist, or has been deleted."
        />
      </PageBody>
    );
  }

  return (
    <div className="h-full flex flex-col animate-slide-up">
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
      <PageBody width="full" className="flex-1 min-h-0 overflow-y-auto">
        <CustomModuleRecordsTab module_={module_} canDelete={canManage} />
      </PageBody>
    </div>
  );
}
