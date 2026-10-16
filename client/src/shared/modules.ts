import { useLicense, type License } from '../api/billing';
import { useAuth } from '../contexts/AuthContext';

/**
 * Which product areas / modules are on for the signed-in org. The platform
 * operator switches HR / CRM / IT Desk (and single sub-modules) per org; the
 * server is the source of truth for both the switches and the catalogue of
 * which routes belong to which module (GET /billing/entitlements → areas,
 * modules, blockedModules — server utils/modules.ts). Nothing here is
 * hard-coded, so the web app and the Android app (same bundle) follow the
 * server.
 *
 * While the licence is loading or failed to load, nothing counts as off — the
 * server still enforces every module with a 402.
 */
export function moduleForPath(lic: License | undefined, path: string) {
  let best: { key: string; len: number } | undefined;
  for (const m of lic?.modules ?? []) {
    for (const r of m.routes) {
      if ((path === r || path.startsWith(r + '/')) && (!best || r.length > best.len)) best = { key: m.key, len: r.length };
    }
  }
  return best ? lic!.modules!.find(m => m.key === best!.key) : undefined;
}

export function useModules() {
  const { user } = useAuth();
  const { data: lic, isLoading } = useLicense(!!user?.role && user.role !== 'PLATFORM_ADMIN');
  const blocked = new Set(lic?.blockedModules ?? []);
  const disabled = new Set(lic?.disabledFeatures ?? []);
  const isModuleOn = (key: string) => !blocked.has(key);
  const isAreaOn = (area: 'hr' | 'crm' | 'itdesk') => {
    const a = lic?.areas?.find(x => x.key === area);
    return !a || !blocked.has(a.root);
  };
  const enabledAreas = (lic?.areas ?? []).filter(a => !blocked.has(a.root)).map(a => a.key);
  // Shared screens that only belong next to certain areas (server
  // SHARED_SURFACES: Inbox, Import, Analytics, …) — off while none of them is on.
  const surfaceForPath = (path: string) =>
    (lic?.surfaces ?? []).find(sf => sf.routes.some(r => path === r || path.startsWith(r + '/')));
  const blockedModuleForPath = (path: string): { key: string; label: string; area?: string } | undefined => {
    const m = moduleForPath(lic, path);
    if (m && blocked.has(m.key)) return m;
    const sf = surfaceForPath(path);
    if (sf && lic?.areas?.length && !sf.areas.some(a => enabledAreas.includes(a))) return { key: sf.key, label: sf.label };
    return undefined;
  };
  return {
    enabledAreas,
    licence: lic,
    loading: isLoading,
    isModuleOn,
    isAreaOn,
    isRouteBlocked: (path: string) => !!blockedModuleForPath(path),
    blockedModuleForPath,
    /** The area a module belongs to, switched off by the operator (vs. just missing from the plan). */
    areaOf: (moduleKey: string) => lic?.areas?.find(a => a.modules.includes(moduleKey)),
    isSwitchedOff: (key: string) => disabled.has(key),
    /** False for a role whose work is an area that's switched off (IT agent
     *  with IT Desk off, sales rep with CRM off) — role pickers leave those
     *  out when adding people; existing users keep their role. */
    isRoleOffered: (legacyRole: string | null | undefined) => {
      if (!legacyRole) return true;
      const area = lic?.areas?.find(a => a.roles.includes(legacyRole));
      return !area || !blocked.has(area.root);
    },
  };
}

/** "a", "a and b", "a, b and c" — for sentences that name only enabled areas. */
export function joinWords(words: (string | false | null | undefined)[]): string {
  const w = words.filter(Boolean) as string[];
  return w.length <= 1 ? (w[0] ?? '') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
}
