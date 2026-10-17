import { useState } from 'react';
import {
  useEmployees,
  useEmployeeStats,
  usePeopleStats,
  useDepartments,
  useOrgChart,
  type OrgChartNode,
} from '../../api/people';
import {
  PageHeader, PageBody, Toolbar, Card, StatTile, Tabs, Button, IconButton, Badge, StatusBadge,
  EmptyState, SearchInput, Avatar, Select, RowActions, SkeletonTable, SkeletonCard,
} from '../../shared/components';
import { Users, Plus, Network, Building2, Mail, Phone, Eye, Pencil } from 'lucide-react';
import { useFormat } from '../../hooks/useFormat';
import { AddPersonModal, EditPersonModal } from '../people/PersonForms';
import { PersonDetailModal, STATUS_VARIANT } from '../people/PersonDetail';

/**
 * Employee directory + org chart.
 *
 * Adding and editing go through the same shared forms as People
 * (modules/people/PersonForms.tsx) and the same profile view
 * (PersonDetail.tsx), so this screen can no longer drift into its own,
 * thinner version of "add employee".
 */

// ─── Org chart ────────────────────────────────────────────────────────────────

function ChartNode({ node, depth = 0, onOpen }: { node: OrgChartNode; depth?: number; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(depth < 2);
  return (
    <div className={depth > 0 ? 'ml-5 border-l border-line pl-4' : ''}>
      <div className="flex items-center gap-2 py-1.5">
        {node.reports.length > 0 ? (
          <IconButton
            size="xs"
            label={open ? 'Collapse reports' : 'Expand reports'}
            icon={<span className="text-[10px]">{open ? '▾' : '▸'}</span>}
            onClick={() => setOpen(v => !v)}
          />
        ) : (
          <span className="w-4" />
        )}
        <button type="button" onClick={() => onOpen(node.id)} className="min-w-0 text-left hover:underline decoration-line">
          <p className="text-[13px] font-medium text-fg truncate">{node.displayName}</p>
          <p className="text-[11px] text-fg-subtle truncate">
            <span data-user-content="designation">{node.designation || node.employeeCode}</span>
            {node.department ? ` · ${node.department.name}` : ''}
            {node.reports.length ? ` · ${node.reports.length} report${node.reports.length > 1 ? 's' : ''}` : ''}
          </p>
        </button>
      </div>
      {open && node.reports.map(r => <ChartNode key={r.id} node={r} depth={depth + 1} onOpen={onOpen} />)}
    </div>
  );
}

function OrgChartPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading } = useOrgChart();
  if (isLoading) return <SkeletonCard lines={6} />;
  if (!data?.data.length) {
    return (
      <EmptyState
        icon={<Network />}
        title="No org chart yet"
        description="Set a reporting manager on employee records and the hierarchy will build itself here."
      />
    );
  }
  return (
    <Card padding="sm">
      <p className="text-[12px] text-fg-subtle mb-3">
        {data.total} people · employees with no manager set appear as roots
      </p>
      {data.data.map(n => (
        <ChartNode key={n.id} node={n} onOpen={onOpen} />
      ))}
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeesPage() {
  const [tab, setTab] = useState<'list' | 'chart'>('list');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const { data: peopleStats } = usePeopleStats();
  const access = peopleStats?.access;

  const { data, isLoading } = useEmployees({
    search: search || undefined,
    departmentId: departmentId || undefined,
    employmentStatus: status || undefined,
  });
  const { data: stats } = useEmployeeStats();
  const { data: departments } = useDepartments();
  const fmt = useFormat();

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Employees"
        subtitle="The people who work here — separate from logins, so staff without system access are still tracked."
        actions={
          access?.canCreate ? (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setNewOpen(true)}>
              Add person
            </Button>
          ) : undefined
        }
      />

      <div className="flex-1 overflow-auto">
        <PageBody width="full">
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total', value: stats.total },
                { label: 'Joined (30d)', value: stats.recentJoiners },
                { label: 'On notice', value: stats.exiting },
                { label: 'Departments', value: stats.byDepartment.length },
              ].map(s => (
                <StatTile key={s.label} label={s.label} value={s.value} />
              ))}
            </div>
          )}

          <Toolbar>
            <Tabs<'list' | 'chart'>
              aria-label="Employee views"
              variant="segmented"
              value={tab}
              onChange={setTab}
              items={[
                { key: 'list', label: 'Directory' },
                { key: 'chart', label: 'Org chart' },
              ]}
            />

            {tab === 'list' && (
              <>
                <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, email…" />
                <Select
                  selectSize="sm"
                  aria-label="Filter by department"
                  className="w-auto"
                  value={departmentId}
                  onChange={e => setDepartmentId(e.target.value)}
                >
                  <option value="">All departments</option>
                  {(departments?.data ?? []).map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
                <Select
                  selectSize="sm"
                  aria-label="Filter by status"
                  className="w-auto"
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {['ACTIVE', 'PROBATION', 'ON_LEAVE', 'NOTICE_PERIOD', 'EXITED'].map(s => (
                    <option key={s} value={s}>
                      {s.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </Toolbar>

          {tab === 'chart' ? (
            <OrgChartPanel onOpen={setDetailId} />
          ) : isLoading ? (
            <SkeletonTable rows={6} />
          ) : !data?.data.length ? (
            <EmptyState
              icon={<Users />}
              title="No employees yet"
              description="Add your first employee, or run the backfill script to create records from your existing users."
              action={access?.canCreate ? { label: 'Add person', onClick: () => setNewOpen(true) } : undefined}
            />
          ) : (
            <Card padding="none" className="overflow-hidden">
              {data.data.map(e => (
                <div
                  key={e.id}
                  className="flex items-start sm:items-center gap-2 px-4 py-3 border-b border-line-subtle last:border-0 hover:bg-surface-hover transition-colors"
                >
                <button
                  type="button"
                  onClick={() => setDetailId(e.id)}
                  className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 text-left"
                >
                  {/* Phones: badges drop under the name instead of squeezing it. */}
                  <div className="flex items-center gap-3 min-w-0 flex-1 w-full">
                  <Avatar name={e.displayName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium text-fg truncate" title={e.displayName}>{e.displayName}</p>
                    <div className="flex items-center gap-2 text-[11px] text-fg-subtle flex-wrap">
                      <span>{e.employeeCode}</span>
                      {e.designation && <span data-user-content="designation">· {e.designation}</span>}
                      {e.department && (
                        <span className="inline-flex items-center gap-1">
                          · <Building2 size={10} /> {e.department.name}
                        </span>
                      )}
                      {e.workEmail && (
                        <span className="inline-flex items-center gap-1 min-w-0 break-all">
                          · <Mail size={10} /> {e.workEmail}
                        </span>
                      )}
                      {e.phone && (
                        <span className="inline-flex items-center gap-1">
                          · <Phone size={10} /> {e.phone}
                        </span>
                      )}
                    </div>
                  </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap sm:shrink-0 pl-11 sm:pl-0">
                    {!e.user && <Badge variant="orange">No login</Badge>}
                    <StatusBadge value={e.employmentStatus} map={STATUS_VARIANT} dot />
                    <span className="text-[11px] text-fg-subtle tabular-nums hidden sm:block">
                      {fmt.date(e.joiningDate)}
                    </span>
                  </div>
                </button>
                <div className="shrink-0">
                  <RowActions
                    triggerLabel={`Actions for ${e.displayName}`}
                    items={[
                      { label: 'View profile', icon: <Eye size={13} />, onClick: () => setDetailId(e.id) },
                      { label: 'Edit details', icon: <Pencil size={13} />, onClick: () => setEditId(e.id), hidden: !access?.canEdit },
                    ]}
                  />
                </div>
                </div>
              ))}
            </Card>
          )}
        </PageBody>
      </div>

      <AddPersonModal open={newOpen} onClose={() => setNewOpen(false)} />
      <PersonDetailModal id={detailId} onClose={() => setDetailId(null)} />
      <EditPersonModal personId={editId} onClose={() => setEditId(null)} />
    </div>
  );
}
