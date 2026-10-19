/**
 * Time-zone names that Postgres actually understands.
 *
 * Org settings store whatever IANA name the browser reported, and older
 * browsers/OSes report legacy aliases — most importantly "Asia/Calcutta" for
 * India. Node's Intl accepts those, but Postgres reads time zones from the
 * server's tzdata, and recent Debian/Ubuntu releases moved the legacy aliases
 * into a separate `tzdata-legacy` package. On such a server
 * `AT TIME ZONE 'Asia/Calcutta'` fails, which made every analytics query on a
 * timestamp field (trends, forecasts, lists with dates) return a 500 in
 * production while date-only fields kept working.
 *
 * So the zone used in SQL is resolved to a canonical name and then checked
 * against pg_timezone_names; if Postgres still doesn't know it, UTC is used
 * and the caller gets a warning rather than an error.
 */
import { prisma } from '../prisma';

/** Legacy alias → canonical IANA name (tzdata "backward" links people actually hit). */
const LEGACY_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ujung_Pandang': 'Asia/Makassar',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Chongqing': 'Asia/Shanghai',
  'Asia/Chungking': 'Asia/Shanghai',
  'Asia/Harbin': 'Asia/Shanghai',
  'Asia/Tel_Aviv': 'Asia/Jerusalem',
  'Asia/Istanbul': 'Europe/Istanbul',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Nicosia': 'Asia/Nicosia',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Australia/ACT': 'Australia/Sydney',
  'Australia/NSW': 'Australia/Sydney',
  'Australia/Canberra': 'Australia/Sydney',
  'Australia/Victoria': 'Australia/Melbourne',
  'Australia/Queensland': 'Australia/Brisbane',
  'Australia/West': 'Australia/Perth',
  'Australia/South': 'Australia/Adelaide',
  'Australia/North': 'Australia/Darwin',
  'Australia/Tasmania': 'Australia/Hobart',
  'US/Eastern': 'America/New_York',
  'US/Central': 'America/Chicago',
  'US/Mountain': 'America/Denver',
  'US/Pacific': 'America/Los_Angeles',
  'US/Alaska': 'America/Anchorage',
  'US/Hawaii': 'Pacific/Honolulu',
  'US/Arizona': 'America/Phoenix',
  'Canada/Eastern': 'America/Toronto',
  'Canada/Central': 'America/Winnipeg',
  'Canada/Mountain': 'America/Edmonton',
  'Canada/Pacific': 'America/Vancouver',
  'Canada/Atlantic': 'America/Halifax',
  'Brazil/East': 'America/Sao_Paulo',
  'Mexico/General': 'America/Mexico_City',
  'GB': 'Europe/London',
  'Eire': 'Europe/Dublin',
  'Singapore': 'Asia/Singapore',
  'Japan': 'Asia/Tokyo',
  'Hongkong': 'Asia/Hong_Kong',
  'ROK': 'Asia/Seoul',
  'PRC': 'Asia/Shanghai',
  'Israel': 'Asia/Jerusalem',
  'Turkey': 'Europe/Istanbul',
  'Egypt': 'Africa/Cairo',
  'NZ': 'Pacific/Auckland',
  'Etc/UCT': 'UTC',
  'Etc/Universal': 'UTC',
  'Etc/Zulu': 'UTC',
  'Etc/GMT': 'UTC',
  'GMT': 'UTC',
  'UCT': 'UTC',
  'Universal': 'UTC',
  'Zulu': 'UTC',
};

/** Canonical name for a zone (pure; no database). */
export function canonicalTimeZone(tz: string): string {
  return LEGACY_ALIASES[tz] ?? tz;
}

const known = new Map<string, boolean>();

async function postgresKnows(tz: string): Promise<boolean> {
  const hit = known.get(tz);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: unknown }>>(
      'SELECT count(*)::int AS n FROM pg_timezone_names WHERE name = $1', tz,
    );
    ok = Number(rows?.[0]?.n ?? 0) > 0;
  } catch {
    // Can't check (e.g. a stubbed DB in tests): trust the canonical name.
    ok = true;
  }
  known.set(tz, ok);
  return ok;
}

/**
 * The zone to use in SQL for an org whose setting is `tz` (already validated
 * by Intl). Returns the zone and, when it had to fall back, a warning.
 */
export async function sqlTimeZone(tz: string): Promise<{ timezone: string; warning?: string }> {
  const canonical = canonicalTimeZone(tz);
  if (canonical === 'UTC' || (await postgresKnows(canonical))) return { timezone: canonical };
  if (canonical !== tz && (await postgresKnows(tz))) return { timezone: tz };
  return {
    timezone: 'UTC',
    warning: `The database doesn't recognise the time zone "${tz}", so dates are shown in UTC. Pick the time zone again in Org Settings.`,
  };
}

/** For tests. */
export function _resetTimeZoneCache(): void { known.clear(); }
