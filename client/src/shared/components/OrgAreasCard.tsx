import { CheckCircle2, MinusCircle } from 'lucide-react';
import { Card } from './Card';
import { Badge } from './Badge';
import { useModules } from '../modules';

/**
 * Read-only view of the product areas (HR / CRM / IT Desk) and their
 * sub-modules switched on for this org. Only the platform operator can change
 * them (Platform Admin → Areas) — shown to the org's admin on Billing and Org
 * Settings so they know what they have and whom to ask.
 */
export function OrgAreasCard() {
  const { licence, isAreaOn, isModuleOn } = useModules();
  if (!licence?.areas?.length) return null;
  return (
    <Card data-testid="org-areas">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">Product areas</p>
      <p className="text-[12.5px] text-fg-muted mb-3">Enabled for your organisation by your service provider. Contact them to change this.</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {licence.areas.map(a => {
          const on = isAreaOn(a.key);
          return (
            <div key={a.key} className={`rounded-card border p-3 min-w-0 ${on ? 'border-line' : 'border-line-subtle opacity-70'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-fg text-sm">{a.label}</span>
                <Badge variant={on ? 'green' : 'gray'}>{on ? 'Enabled' : 'Not enabled'}</Badge>
              </div>
              <p className="text-[11.5px] text-fg-muted mt-1">{a.description}</p>
              {on && (
                <ul className="mt-2 space-y-0.5">
                  {a.modules.map(k => {
                    const m = licence.modules?.find(x => x.key === k);
                    const mOn = isModuleOn(k) && licence.features.includes(k);
                    return (
                      <li key={k} className="flex items-center gap-1.5 text-[12px] text-fg">
                        {mOn ? <CheckCircle2 size={12} className="text-success shrink-0" /> : <MinusCircle size={12} className="text-fg-subtle shrink-0" />}
                        <span className={mOn ? '' : 'text-fg-subtle'}>{m?.label ?? k}</span>
                        {!mOn && <span className="text-[10.5px] text-fg-subtle">{isModuleOn(k) ? '(not in plan)' : '(off)'}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
