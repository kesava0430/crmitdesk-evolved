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

// ICU/CLDR (what Intl draws on) doesn't actually know informal abbreviations
// like "IST" for Asia/Kolkata — Intl.DateTimeFormat's 'short' timeZoneName
// just falls back to a GMT offset for zones without a standardized short
// form, so deriving abbreviations purely from Intl at runtime silently
// leaves out exactly the ones people search for most. This is a small,
// deliberately non-exhaustive map of the common ones; anything not listed
// still gets its UTC offset appended below, which is searchable too (e.g.
// "+5:30").
const COMMON_ABBR: Record<string, string> = {
  'Asia/Kolkata': 'IST', 'Asia/Calcutta': 'IST',
  'America/New_York': 'EST/EDT', 'America/Chicago': 'CST/CDT',
  'America/Denver': 'MST/MDT', 'America/Los_Angeles': 'PST/PDT',
  'America/Anchorage': 'AKST/AKDT', 'Pacific/Honolulu': 'HST',
  'Europe/London': 'GMT/BST', 'Europe/Paris': 'CET/CEST',
  'Europe/Berlin': 'CET/CEST', 'Europe/Madrid': 'CET/CEST',
  'Europe/Moscow': 'MSK', 'Asia/Dubai': 'GST',
  'Asia/Karachi': 'PKT', 'Asia/Dhaka': 'BST',
  'Asia/Shanghai': 'CST', 'Asia/Hong_Kong': 'HKT',
  'Asia/Singapore': 'SGT', 'Asia/Tokyo': 'JST',
  'Asia/Seoul': 'KST', 'Australia/Sydney': 'AEST/AEDT',
  'Australia/Perth': 'AWST', 'Pacific/Auckland': 'NZST/NZDT',
};

// The IANA zone name alone ("Asia/Kolkata") doesn't contain the abbreviation
// people actually search for ("IST", "PST", "GMT"...) — SearchableSelect only
// filters against the label text, so without this someone typing "IST" would
// see no results even though Asia/Kolkata is right there in the list.
// Appending the abbreviation + UTC offset makes both the zone and its common
// short name searchable, and disambiguates zones that share an offset.
function timezoneLabel(tz: string): string {
  try {
    const offsetParts = new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    const offset = offsetParts.find(p => p.type === 'timeZoneName')?.value ?? '';
    const abbr = COMMON_ABBR[tz];
    const suffix = [abbr, offset].filter(Boolean).join(' ');
    return `${tz.replace(/_/g, ' ')}${suffix ? ` (${suffix})` : ''}`;
  } catch {
    return tz.replace(/_/g, ' ');
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
  const timezoneOptions = useMemo(() => supportedTimeZones().map(tz => ({ value: tz, label: timezoneLabel(tz) })), []);

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
