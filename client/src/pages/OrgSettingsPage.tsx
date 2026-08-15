import { useEffect, useMemo, useState } from 'react';
import { Globe2, CheckCircle } from 'lucide-react';
import { useOrgSettings, useUpdateOrgSettings } from '../api/org';
import { SearchableSelect } from '../shared/components';
import { currencySymbol } from '../utils/format';

// Intl.supportedValuesOf('currency'/'timeZone') is the runtime's own ICU
// data — sourcing the picker options from it means this list can never
// drift out of date the way a hand-maintained array would, and it's
// supported in every browser/Node version this app already targets. The
// try/catch fallback only matters for a very old browser that predates it
// (pre-2022 Safari) — a short hardcoded list there is enough to not leave
// the picker empty, not to be exhaustive.
function supportedCurrencies(): string[] {
  try { return (Intl as any).supportedValuesOf('currency'); }
  catch { return ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'JPY', 'CNY', 'SGD', 'AED']; }
}
function supportedTimeZones(): string[] {
  try { return (Intl as any).supportedValuesOf('timeZone'); }
  catch { return ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney']; }
}

function currencyLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'currency' }).of(code);
    return `${code} — ${currencySymbol(code)}${name && name !== code ? ` · ${name}` : ''}`;
  } catch {
    return code;
  }
}

export default function OrgSettingsPage() {
  const { data: org, isLoading } = useOrgSettings();
  const update = useUpdateOrgSettings();
  const [currency, setCurrency] = useState('USD');
  const [timezone, setTimezone] = useState('UTC');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (org) { setCurrency(org.currency); setTimezone(org.timezone); }
  }, [org]);

  const currencyOptions = useMemo(() => supportedCurrencies().map(c => ({ value: c, label: currencyLabel(c) })), []);
  const timezoneOptions = useMemo(() => supportedTimeZones().map(tz => ({ value: tz, label: tz.replace(/_/g, ' ') })), []);

  const dirty = org ? (currency !== org.currency || timezone !== org.timezone) : false;

  function save() {
    update.mutate({ currency, timezone }, {
      onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); },
    });
  }

  const now = new Date();
  let preview = '';
  try {
    preview = new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(now);
  } catch { preview = now.toLocaleString(); }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Globe2 size={24} className="text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Org Settings</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Currency and time zone used across the whole app for this organization</p>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">Loading…</p>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-5 space-y-5">
          <div>
            <label className="form-label">Currency</label>
            <SearchableSelect
              ariaLabel="Currency"
              value={currency}
              onChange={setCurrency}
              options={currencyOptions}
              required
            />
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
              Applies to deal values, quotes, invoices, and payroll amounts across the app — e.g. {new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(1234.5)}.
            </p>
          </div>

          <div>
            <label className="form-label">Time zone</label>
            <SearchableSelect
              ariaLabel="Time zone"
              value={timezone}
              onChange={setTimezone}
              options={timezoneOptions}
              required
            />
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
              Applies to ticket/deal/activity timestamps app-wide — right now that's <strong>{preview}</strong>. Dates are still stored the same way either way; this only changes how they're displayed.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={save}
              disabled={!dirty || update.isPending}
              className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              {update.isPending ? 'Saving…' : 'Save Changes'}
            </button>
            {saved && (
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                <CheckCircle size={15} /> Saved
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
