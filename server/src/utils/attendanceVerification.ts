// Geofence + "office network" verification helpers for Attendance check-in/
// check-out (see modules/hr/attendance/attendance.controller.ts). Browsers
// don't expose the connected WiFi network's name/SSID to JavaScript on any
// platform (a deliberate privacy restriction) — the closest practical
// equivalent is matching the request's public IP address against an
// admin-configured allowlist for the office, combined with a GPS radius
// check. Neither on its own is bulletproof (IPs can be spoofed by a VPN
// pointed at the office egress, GPS can be mocked on a rooted/jailbroken
// device), but together they're a reasonable, honest approximation — and
// the manager manual-entry override exists precisely for the legitimate
// exceptions (approved WFH, field visits, a flaky GPS fix) this can't
// perfectly handle.

/** Great-circle distance between two lat/lng points, in meters. */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth radius, meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export type NetworkCheckStatus = 'not_configured' | 'matched' | 'not_matched';

/**
 * Matches `ip` against a comma-separated allowlist of exact IPv4 addresses
 * and/or CIDR blocks (e.g. "203.0.113.5, 198.51.100.0/24"). Returns
 * 'not_configured' when the allowlist is blank/unset for this office (no
 * opinion either way), rather than collapsing that into the same boolean as
 * an actual match — see verifyAgainstOffices() below for why the difference
 * matters: "not configured" must never be treated as a passing signal on
 * its own, or every office without an IP allowlist would auto-pass network
 * checks and geofencing would be silently disabled for it.
 */
export function checkNetworkAllowlist(ip: string | undefined | null, allowlist: string | null | undefined): NetworkCheckStatus {
  if (!allowlist || !allowlist.trim()) return 'not_configured';
  if (!ip) return 'not_matched';

  // req.socket.remoteAddress can come back as an IPv4-mapped IPv6 address
  // ("::ffff:203.0.113.5") when there's no x-forwarded-for to prefer (local
  // dev, or a proxy that isn't setting it) — strip that prefix so a plain
  // IPv4 allowlist entry still matches instead of silently failing every
  // comparison because of a "::ffff:" the admin never typed into the field.
  const cleanIp = ip.trim().replace(/^::ffff:/i, '');
  const ipInt = ipv4ToInt(cleanIp);

  const matched = allowlist.split(',').map(s => s.trim()).filter(Boolean).some(entry => {
    if (entry === cleanIp) return true;
    if (!entry.includes('/') || ipInt === null) return false;
    const [base, bitsStr] = entry.split('/');
    const baseInt = ipv4ToInt(base);
    const bits = Number(bitsStr);
    if (baseInt === null || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  });
  return matched ? 'matched' : 'not_matched';
}

/** Extracts the caller's public IP the same way the rest of this codebase does (see quotes.controller.ts publicAccept). */
export function extractClientIp(headers: Record<string, unknown>, socketRemoteAddress?: string): string {
  const forwarded = headers['x-forwarded-for'];
  const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (typeof forwardedStr === 'string' ? forwardedStr.split(',')[0]?.trim() : '') || socketRemoteAddress || '';
}

export interface VerificationResult {
  locationOk: boolean;
  /** True unless the IP was actually checked against a configured allowlist
   *  and failed — i.e. false only for a genuine mismatch, matching the
   *  stored checkInNetworkOk/checkOutNetworkOk columns' existing meaning
   *  ("the network check didn't fail", not "the network check passed"). */
  networkOk: boolean;
  networkStatus: NetworkCheckStatus;
  /** Overall verified for this office, driven by what that office actually
   *  has configured: GPS geofencing is always on (every office has
   *  latitude/longitude/radius), so an office with no IP allowlist relies on
   *  GPS alone. An office that *also* has an IP allowlist configured
   *  requires BOTH — GPS-in-range AND a matching IP — since an admin who
   *  went to the trouble of setting up network verification intends it as
   *  an additional check, not an alternate, weaker path that GPS-in-range
   *  alone can satisfy on its own (which would mean someone off the office
   *  network but merely standing nearby, or with a spoofed GPS reading,
   *  could check in). Earlier versions of this logic went through both a
   *  too-strict AND-always (blocked legitimate on-network employees with a
   *  poor GPS fix indoors) and a too-loose OR-always (let GPS-in-range pass
   *  on its own even for offices that deliberately configured an IP
   *  allowlist) — this "require what's configured" version is the
   *  intentional middle ground. */
  passed: boolean;
  /** Name of the office location matched (closest one that passed, or the closest overall if none passed). */
  matchedLocationName: string | null;
  nearestDistanceMeters: number | null;
}

/** Checks (lat,lng,ip) against every active OfficeLocation for the org and returns the best match. */
export function verifyAgainstOffices(
  offices: { name: string; latitude: number; longitude: number; radiusMeters: number; allowedIps: string | null }[],
  lat: number,
  lng: number,
  ip: string,
): VerificationResult {
  if (offices.length === 0) {
    return { locationOk: false, networkOk: false, networkStatus: 'not_configured', passed: false, matchedLocationName: null, nearestDistanceMeters: null };
  }

  let best: VerificationResult & { distance: number } = {
    locationOk: false, networkOk: false, networkStatus: 'not_configured', passed: false,
    matchedLocationName: null, nearestDistanceMeters: null, distance: Infinity,
  };

  for (const office of offices) {
    const distance = distanceMeters(lat, lng, office.latitude, office.longitude);
    const locationOk = distance <= office.radiusMeters;
    const networkStatus = checkNetworkAllowlist(ip, office.allowedIps);
    const networkOk = networkStatus !== 'not_matched';
    // "Require what's configured": no IP allowlist on this office means GPS
    // is the only signal that exists, so GPS-in-range alone passes. An IP
    // allowlist configured means the admin wants network verification
    // enforced too, so both have to hold — GPS-in-range alone (e.g.
    // standing near the building on mobile data, not office WiFi) is no
    // longer sufficient for that office once it opts into IP checking.
    const passed = networkStatus === 'not_configured'
      ? locationOk
      : locationOk && networkStatus === 'matched';

    if ((passed && !best.passed) || (!best.passed && distance < best.distance)) {
      best = { locationOk, networkOk, networkStatus, passed, matchedLocationName: office.name, nearestDistanceMeters: Math.round(distance), distance };
    }
  }

  const { distance, ...result } = best;
  return result;
}

/**
 * Total worked minutes across every session (AttendanceRecord row) passed
 * in — a completed session contributes checkOutAt - checkInAt; a still-open
 * session (checked in, not yet checked out) contributes up to `now` so a
 * "hours today" total keeps ticking up live rather than reading as 0 until
 * the person checks out. Records with no checkInAt at all (shouldn't happen,
 * but defensively) contribute nothing.
 */
export function sumWorkedMinutes(
  records: { checkInAt: Date | null; checkOutAt: Date | null }[],
  now: Date = new Date(),
): number {
  let total = 0;
  for (const r of records) {
    if (!r.checkInAt) continue;
    const end = r.checkOutAt ?? now;
    const mins = (end.getTime() - r.checkInAt.getTime()) / 60000;
    if (mins > 0) total += mins;
  }
  return Math.round(total);
}
