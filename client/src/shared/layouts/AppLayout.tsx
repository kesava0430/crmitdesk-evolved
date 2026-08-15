import { useState, useEffect } from "react";
import { Outlet, NavLink, Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import {
  LayoutDashboard, Users, Target, TrendingUp,
  Ticket, FolderTree, BookOpen, LogOut,
  BarChart2, UserCog, Inbox, Zap, Globe, Globe2, CreditCard, Slack, Monitor,
  Mail, GitBranch, Key, Shield, Settings2, Upload, MessageSquare, Palette,
  FileText, Menu, Sparkles, Wand2, Brain, LayoutTemplate, HardDrive, Layers,
  Clock, CalendarCheck, Building2, Receipt, RefreshCw, Wallet, KeyRound,
  Package, Boxes, Wrench, Tag, Briefcase, ClipboardList,
  CheckSquare, CheckCircle2, Network, UserSquare2,
} from "lucide-react";
import { useCustomModules } from "../../api/customModules";
import { AISmartSearch } from "../components/AISmartSearch";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { NotificationBell } from "../components/NotificationBell";
import { AiCommandBar } from "../components/AiCommandBar";
import { ThemePicker } from "../components/ThemePicker";
import { useLabels, type LabelEntityKey } from "../../hooks/useLabels";

// Which nav routes / page-title routes correspond to a relabelable entity —
// same 4 entities the AI Setup Generator can propose overrides for
// (aiStudio.controller.ts ENTITY_KEYS). Anything not listed here just keeps
// its hardcoded label, override or not.
const ROUTE_ENTITY: Record<string, { key: LabelEntityKey; form: "singular" | "plural" }> = {
  "/itdesk/tickets": { key: "ticket",  form: "plural" },
  "/crm/deals":      { key: "deal",    form: "plural" },
  "/crm/leads":      { key: "lead",    form: "plural" },
  "/crm/contacts":   { key: "contact", form: "plural" },
};

// Nav sections

type NavItem = {
  to: string;
  label: string;
  icon: React.ElementType;
  roles?: string[];
};

type NavSection = {
  label: string | null;
  roles?: string[];
  items: NavItem[];
};

// Exported so App.tsx can derive server-mirroring route-level role guards
// from the exact same config that drives sidebar visibility (see
// shared/routeAccess.ts) — one source of truth instead of two lists that can
// drift apart.
export const NAV_SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { to: "/dashboard",    label: "Dashboard",  icon: LayoutDashboard },
      { to: "/my-work",      label: "My Work",     icon: CheckSquare },
      { to: "/approvals",    label: "Approvals",   icon: CheckCircle2 },
      { to: "/inbox",        label: "Inbox",       icon: Inbox },
      { to: "/workflows",    label: "Automation",  icon: Zap,   roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/portal-users", label: "Portal",      icon: Globe, roles: ['SUPER_ADMIN', 'IT_MANAGER'] },
      { to: "/ai-builder",   label: "AI Builder",  icon: Wand2, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/ai-studio",    label: "AI Studio",   icon: Brain, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
    ],
  },
  {
    label: "CRM",
    roles: ['SUPER_ADMIN', 'CRM_MANAGER', 'SALES_REP'],
    items: [
      { to: "/crm/contacts", label: "Contacts",  icon: Users },
      { to: "/crm/leads",    label: "Leads",     icon: Target },
      { to: "/crm/deals",    label: "Pipeline",  icon: TrendingUp },
      { to: "/quotes",       label: "Quotes",    icon: FileText },
      { to: "/invoices",     label: "Invoices",  icon: Receipt },
      { to: "/campaigns",    label: "Campaigns", icon: Mail },
    ],
  },
  {
    label: "HR",
    items: [
      { to: "/hr/employees",  label: "Employees",   icon: UserSquare2 },
      { to: "/hr/org",        label: "Org Structure", icon: Network, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/hr/attendance", label: "Attendance",  icon: Clock },
      { to: "/hr/leave",      label: "Leave",       icon: CalendarCheck },
      { to: "/hr/payroll",    label: "Payroll",     icon: Wallet },
      { to: "/hr/settings",   label: "HR Settings", icon: Building2, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
    ],
  },
  {
    label: "IT Desk",
    items: [
      { to: "/itdesk/tickets",    label: "Tickets",        icon: Ticket },
      { to: "/itdesk/categories", label: "Categories",     icon: FolderTree },
      { to: "/itdesk/articles",   label: "Knowledge Base", icon: BookOpen },
      { to: "/itdesk/assets",     label: "Assets",         icon: Monitor,    roles: ['SUPER_ADMIN', 'IT_MANAGER', 'IT_AGENT'] },
      { to: "/change-requests",   label: "Changes",        icon: GitBranch,  roles: ['SUPER_ADMIN', 'IT_MANAGER', 'IT_AGENT'] },
    ],
  },
  {
    label: "Admin",
    items: [
      { to: "/admin/users",   label: "Users",         icon: UserCog,  roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/analytics",     label: "Analytics",     icon: BarChart2, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/reports",       label: "Reports",       icon: BarChart2, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/import",        label: "Import CSV",    icon: Upload,    roles: ['SUPER_ADMIN', 'CRM_MANAGER'] },
      { to: "/custom-fields", label: "Custom Fields", icon: Settings2 },
      { to: "/custom-modules", label: "Custom Modules", icon: Layers, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/templates",     label: "Templates",     icon: LayoutTemplate },
      { to: "/branding",      label: "Branding",      icon: Palette },
      { to: "/org-settings",  label: "Org Settings",  icon: Globe2,    roles: ['SUPER_ADMIN'] },
      { to: "/admin/roles",   label: "Roles & Permissions", icon: Shield, roles: ['SUPER_ADMIN'] },
      { to: "/admin/ai-governance", label: "AI Governance", icon: Brain, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/audit-logs",    label: "Audit Log",     icon: Shield,    roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/api-keys",      label: "API Keys",      icon: Key,       roles: ['SUPER_ADMIN'] },
      { to: "/jobs",          label: "Background Jobs", icon: RefreshCw, roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/slack",        label: "Slack",        icon: Slack,        roles: ['SUPER_ADMIN', 'IT_MANAGER'] },
      { to: "/teams",        label: "Teams",        icon: MessageSquare, roles: ['SUPER_ADMIN', 'IT_MANAGER'] },
      { to: "/directory-sso", label: "Single Sign-On", icon: KeyRound,   roles: ['SUPER_ADMIN', 'IT_MANAGER'] },
      { to: "/storage",      label: "Storage",      icon: HardDrive,    roles: ['SUPER_ADMIN', 'IT_MANAGER', 'CRM_MANAGER'] },
      { to: "/billing",      label: "Billing",      icon: CreditCard,   roles: ['SUPER_ADMIN'] },
      { to: "/security/2fa", label: "2FA Security", icon: Shield },
    ],
  },
];

// Icon an org can pick for a custom module (CustomModule.icon, currently only
// ever "Layers" since CustomModulesPage.tsx's create form has no picker yet —
// this map exists so a future picker (or a hand-edited value) just works
// without a matching code change here. Unknown/unset names fall back to Layers.
const CUSTOM_MODULE_ICONS: Record<string, React.ElementType> = {
  Layers, Package, Boxes, Wrench, Tag, Briefcase, ClipboardList, FileText, Building2, Monitor,
};

// Route -> page title map (for topbar)
const PAGE_TITLES: Record<string, string> = {
  "/dashboard":         "Dashboard",
  "/inbox":             "Inbox",
  "/workflows":         "Automation",
  "/portal-users":      "Customer Portal",
  "/crm/contacts":      "Contacts",
  "/crm/leads":         "Leads",
  "/crm/deals":         "Pipeline",
  "/quotes":            "Quotes",
  "/invoices":          "Invoices",
  "/campaigns":         "Campaigns",
  "/hr/attendance":     "Attendance",
  "/hr/leave":          "Leave",
  "/hr/payroll":        "Payroll",
  "/hr/settings":       "HR Settings",
  "/itdesk/tickets":    "Tickets",
  "/itdesk/categories": "Categories",
  "/itdesk/articles":   "Knowledge Base",
  "/itdesk/assets":     "Assets",
  "/change-requests":   "Change Requests",
  "/admin/users":       "Users",
  "/analytics":         "Analytics",
  "/reports":           "Reports",
  "/import":            "Bulk Import",
  "/custom-fields":     "Custom Fields",
  "/custom-modules":    "Custom Modules",
  "/templates":         "Templates",
  "/branding":          "Branding",
  "/org-settings":      "Org Settings",
  "/audit-logs":        "Audit Log",
  "/api-keys":          "API Keys",
  "/jobs":              "Background Jobs",
  "/slack":             "Slack Integration",
  "/teams":             "Microsoft Teams",
  "/directory-sso":     "Single Sign-On",
  "/storage":           "Storage",
  "/billing":           "Billing",
  "/security/2fa":      "2FA Security",
  "/ai-builder":        "AI Feature Builder",
  "/ai-studio":         "AI Studio",
  "/profile":           "My Profile",
};

// Sidebar nav item

function SideNavItem({ to, label, icon: Icon, onClick }: {
  to: string; label: string; icon: React.ElementType; onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        `group flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors duration-150 ${
          isActive
            ? "bg-indigo-600/20 dark:bg-indigo-900/30 text-indigo-300 dark:text-indigo-400 font-semibold"
            : "text-slate-400 hover:text-slate-200 hover:bg-white/5 dark:hover:bg-gray-800"
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={15} className={isActive ? "text-white" : "text-slate-500 group-hover:text-slate-300"} />
          <span className="truncate flex-1">{label}</span>
        </>
      )}
    </NavLink>
  );
}

// Sidebar content

function SidebarContent({ user, onLogout, onNavClick }: {
  user: any; onLogout: () => void; onNavClick?: () => void;
}) {
  const userRole: string | undefined = user?.role;
  const { entityLabel } = useLabels();

  // Each org's own custom modules (see modules/custom-modules) get their own
  // sidebar entry here, instead of only being reachable through the generic
  // "Custom Modules" builder link under Admin — that link is still there for
  // defining fields/sync; these are the day-to-day "go look at the records"
  // links. Folded into whichever existing section the module's own
  // CustomModule.navSection picks (set on the module — see
  // CreateModuleModal/EditModuleModal in CustomModulesPage.tsx), rather than
  // always CRM or a dedicated section — appended only for rendering (NOT
  // pushed into the exported NAV_SECTIONS, since routeAccess.ts derives its
  // role guard from that array). Note this means a module's link inherits
  // whichever section it's placed in's role restriction for sidebar
  // *visibility* (e.g. an IT Desk-placed module is hidden from a SALES_REP).
  // The underlying /modules/:slug route and the records API itself stay
  // ALL_STAFF/unrestricted regardless of placement (see App.tsx's route
  // comment) — this only affects whether it shows up in the sidebar, same
  // "hidden from nav, not blocked by URL" pattern routeAccess.ts already
  // uses everywhere else.
  const NAV_SECTION_LABELS: Record<string, string> = { CRM: "CRM", IT_DESK: "IT Desk", HR: "HR", ADMIN: "Admin" };
  const { data: customModules } = useCustomModules();
  const visibleModules = (customModules ?? []).filter((m: any) => m.isActive && (m._count?.fields ?? 0) > 0);
  const sections: NavSection[] = visibleModules.length
    ? NAV_SECTIONS.map(section => {
        const items = visibleModules
          .filter((m: any) => (NAV_SECTION_LABELS[m.navSection] ?? "CRM") === section.label)
          .map((m: any): NavItem => ({ to: `/modules/${m.slug}`, label: m.name, icon: CUSTOM_MODULE_ICONS[m.icon] ?? Layers }));
        return items.length ? { ...section, items: [...section.items, ...items] } : section;
      })
    : NAV_SECTIONS;

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="Logo" className="w-8 h-8 shrink-0" />
          <div className="min-w-0">
            <p className="text-white font-semibold text-sm leading-tight truncate">CRM &amp; IT Desk</p>
            {user?.org?.name && (
              <p className="text-slate-400 text-xs truncate mt-0.5">{user.org.name}</p>
            )}
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 overflow-y-auto sidebar-scroll space-y-0.5">
        {sections.map((section) => {
          // Hide section if user's role is not allowed
          if (section.roles && userRole && !section.roles.includes(userRole)) return null;

          // Filter items by role
          const visibleItems = section.items.filter(
            item => !item.roles || !userRole || item.roles.includes(userRole)
          );
          if (visibleItems.length === 0) return null;

          return (
            <div key={section.label ?? "__top"} className={section.label ? "mt-5" : ""}>
              {section.label && (
                <p className="px-3 mb-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
                  {section.label}
                </p>
              )}
              {visibleItems.map(item => {
                const override = ROUTE_ENTITY[item.to];
                const label = override ? entityLabel(override.key, override.form, item.label) : item.label;
                return <SideNavItem key={item.to} to={item.to} label={label} icon={item.icon} onClick={onNavClick} />;
              })}
            </div>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="border-t border-slate-800 p-3">
        <Link
          to="/profile"
          className="flex items-center gap-3 px-2 py-2 mb-1 rounded-lg hover:bg-white/5 transition-colors group"
          title="My Profile"
        >
          <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 group-hover:ring-2 group-hover:ring-brand-400 transition-all">
            {user?.name?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-xs font-medium truncate">{user?.name}</p>
            <p className="text-slate-500 text-[11px] truncate group-hover:text-slate-400">{user?.role ?? 'Edit profile'}</p>
          </div>
        </Link>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onLogout}
            className="flex-1 flex items-center gap-2 px-3 py-2 text-[13px] text-slate-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
          >
            <LogOut size={14} /> Sign out
          </button>
          <ThemePicker />
        </div>
      </div>
    </div>
  );
}

// Main Layout

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiBarOpen, setAiBarOpen] = useState(false);

  // Close mobile drawer on route change
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Close sidebar on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Cmd+K / Ctrl+K to toggle AI command bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setAiBarOpen(prev => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  function handleLogout() {
    logout();
    navigate("/login");
  }

  const { entityLabel } = useLabels();
  const routeOverride = ROUTE_ENTITY[location.pathname];
  // /modules/:slug has no static PAGE_TITLES entry (one per org-defined
  // module, can't be hardcoded) — fall back to that module's own name if the
  // list happens to already be cached (it always will be, since the sidebar
  // itself just fetched it) rather than showing the generic app name.
  const { data: customModulesForTitle } = useCustomModules();
  const moduleTitleMatch = location.pathname.startsWith("/modules/")
    ? customModulesForTitle?.find((m: any) => `/modules/${m.slug}` === location.pathname)?.name
    : undefined;
  const pageTitle = routeOverride
    ? entityLabel(routeOverride.key, routeOverride.form, PAGE_TITLES[location.pathname] ?? "")
    : (PAGE_TITLES[location.pathname] ?? moduleTitleMatch ?? "CRM & IT Desk");

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-900 overflow-hidden">

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden animate-fade-in"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 w-60 flex flex-col bg-slate-950 shadow-2xl
          transition-transform duration-200 ease-out
          lg:relative lg:translate-x-0 lg:shadow-none lg:z-auto lg:pointer-events-auto
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full pointer-events-none"}
        `}
      >
        <SidebarContent user={user} onLogout={handleLogout} onNavClick={() => setSidebarOpen(false)} />
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Top bar */}
        <header className="flex-shrink-0 flex items-center gap-3 px-4 h-14 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-b border-gray-200/50 dark:border-gray-700/50 shadow-topbar z-30">
          {/* Hamburger — mobile only */}
          <button
            className="lg:hidden p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>

          {/* Page title — use <p> not <h1> to avoid duplicate heading with PageHeader */}
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 hidden sm:block truncate">
            {pageTitle}
          </p>

          <div className="flex-1" />

          {/* Search — desktop */}
          <div className="hidden md:block">
            <AISmartSearch className="w-full max-w-sm" />
          </div>

          <NotificationBell />

          {/* AI Command Bar button */}
          <button
            data-testid="ai-command-btn"
            onClick={() => setAiBarOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-lg transition-colors"
            title="AI Command (Ctrl+K)"
          >
            <Sparkles size={13} /> AI
          </button>

          {/* Avatar — mobile */}
          <div className="lg:hidden w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {user?.name?.[0]?.toUpperCase() ?? "?"}
          </div>
        </header>

        {/* Mobile search bar */}
        <div className="md:hidden px-4 py-2 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
          <AISmartSearch className="w-full" />
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <AiCommandBar open={aiBarOpen} onClose={() => setAiBarOpen(false)} />
    </div>
  );
}
