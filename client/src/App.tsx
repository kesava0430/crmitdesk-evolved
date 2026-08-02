import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppLayout } from './shared/layouts/AppLayout';

// Eagerly loaded — shown before auth or as portal (must be small/fast)
import { LoginPage } from './pages/LoginPage';
import { DemoLandingPage } from './pages/DemoLandingPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { OrgApprovalPage } from './pages/OrgApprovalPage';
import { CustomerPortal } from './modules/portal/CustomerPortal';

// Page skeleton fallback for Suspense
function PageSkeleton() {
  return (
    <div className="p-6 space-y-4 animate-pulse">
      <div className="h-8 bg-gray-100 rounded-xl w-48" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-24 bg-gray-100 rounded-2xl" />)}
      </div>
      <div className="h-64 bg-gray-100 rounded-2xl" />
      <div className="h-48 bg-gray-100 rounded-2xl" />
    </div>
  );
}

// Named exports — use .then(m => ({ default: m.X }))
const DashboardPage    = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const ContactsPage     = lazy(() => import('./modules/crm/contacts/ContactsPage').then(m => ({ default: m.ContactsPage })));
const ContactDetailPage = lazy(() => import('./modules/crm/contacts/ContactDetailPage').then(m => ({ default: m.ContactDetailPage })));
const LeadsPage        = lazy(() => import('./modules/crm/leads/LeadsPage').then(m => ({ default: m.LeadsPage })));
const DealsPage        = lazy(() => import('./modules/crm/deals/DealsPage').then(m => ({ default: m.DealsPage })));
const TicketsPage      = lazy(() => import('./modules/itdesk/tickets/TicketsPage').then(m => ({ default: m.TicketsPage })));
const CategoriesPage   = lazy(() => import('./modules/itdesk/categories/CategoriesPage').then(m => ({ default: m.CategoriesPage })));
const ArticlesPage     = lazy(() => import('./modules/itdesk/articles/ArticlesPage').then(m => ({ default: m.ArticlesPage })));
const UsersPage        = lazy(() => import('./pages/UsersPage').then(m => ({ default: m.UsersPage })));
const ReportsPage      = lazy(() => import('./pages/ReportsPage').then(m => ({ default: m.ReportsPage })));
const InboxPage        = lazy(() => import('./modules/inbox/InboxPage').then(m => ({ default: m.InboxPage })));
const WorkflowsPage    = lazy(() => import('./modules/workflows/WorkflowsPage').then(m => ({ default: m.WorkflowsPage })));
const PortalUsersPage  = lazy(() => import('./modules/portal/PortalUsersPage').then(m => ({ default: m.PortalUsersPage })));
const BillingPage      = lazy(() => import('./pages/BillingPage').then(m => ({ default: m.BillingPage })));
const AnalyticsPage    = lazy(() => import('./pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const AIFeaturePage    = lazy(() => import('./pages/AIFeaturePage').then(m => ({ default: m.AIFeaturePage })));

// Default exports — direct import()
const SlackPage          = lazy(() => import('./pages/SlackPage'));
const AssetsPage         = lazy(() => import('./modules/itdesk/assets/AssetsPage'));
const CampaignsPage      = lazy(() => import('./pages/CampaignsPage'));
const ChangeRequestsPage = lazy(() => import('./pages/ChangeRequestsPage'));
const ApiKeysPage        = lazy(() => import('./pages/ApiKeysPage'));
const AuditLogPage       = lazy(() => import('./pages/AuditLogPage'));
const AIStudioPage       = lazy(() => import('./pages/AIStudioPage'));
const CustomFieldsPage   = lazy(() => import('./pages/CustomFieldsPage'));
const TemplatesPage      = lazy(() => import('./pages/TemplatesPage'));
const BulkImportPage     = lazy(() => import('./pages/BulkImportPage'));
const TeamsPage          = lazy(() => import('./pages/TeamsPage'));
const BrandingPage       = lazy(() => import('./pages/BrandingPage'));
const StoragePage        = lazy(() => import('./pages/StoragePage'));
const CustomModulesPage  = lazy(() => import('./pages/CustomModulesPage'));
const QuotesPage         = lazy(() => import('./pages/QuotesPage'));
const TwoFactorPage      = lazy(() => import('./pages/TwoFactorPage'));
const ProfilePage        = lazy(() => import('./pages/ProfilePage'));

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public customer portal — outside main app layout */}
        <Route path="/portal" element={<CustomerPortal />} />
        <Route path="/portal/verify" element={<CustomerPortal />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/demo" element={<DemoLandingPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/approve-org" element={<OrgApprovalPage />} />
        <Route path="/" element={<ProtectedRoute><Suspense fallback={<PageSkeleton />}><AppLayout /></Suspense></ProtectedRoute>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="crm/contacts" element={<ContactsPage />} />
          <Route path="crm/contacts/:id" element={<ContactDetailPage />} />
          <Route path="crm/leads" element={<LeadsPage />} />
          <Route path="crm/deals" element={<DealsPage />} />
          <Route path="itdesk/tickets" element={<TicketsPage />} />
          <Route path="itdesk/categories" element={<CategoriesPage />} />
          <Route path="itdesk/articles" element={<ArticlesPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="workflows" element={<WorkflowsPage />} />
          <Route path="portal-users" element={<PortalUsersPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="slack" element={<SlackPage />} />
          <Route path="itdesk/assets" element={<AssetsPage />} />
          <Route path="campaigns" element={<CampaignsPage />} />
          <Route path="change-requests" element={<ChangeRequestsPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="admin/users" element={<UsersPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="audit-logs" element={<AuditLogPage />} />
          <Route path="custom-fields" element={<CustomFieldsPage />} />
          <Route path="templates" element={<TemplatesPage />} />
          <Route path="import" element={<BulkImportPage />} />
          <Route path="teams" element={<TeamsPage />} />
          <Route path="branding" element={<BrandingPage />} />
          <Route path="storage" element={<StoragePage />} />
          <Route path="custom-modules" element={<CustomModulesPage />} />
          <Route path="quotes" element={<QuotesPage />} />
          <Route path="security/2fa" element={<TwoFactorPage />} />
          <Route path="ai-builder" element={<AIFeaturePage />} />
          <Route path="ai-studio" element={<AIStudioPage />} />
          <Route path="profile" element={<ProfilePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
