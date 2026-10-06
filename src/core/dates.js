/**
 * Date helpers for the HYROS pipeline (server side, no dependencies).
 *
 * `userProfile.timezone` is typed as a free string by the API, so an account
 * may say "-05:00", "UTC", "GMT-5", "-5" or "America/New_York". Everything
 * here takes any of those; an unparseable value is reported as null so the
 * caller can fall back to UTC loudly (a warning) instead of silently.
 */

/* ---------------- timezone ---------------- */

const OFFSET_RE = /^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;
const ZERO_RE = /^(?:UTC|GMT|Z|UCT|Etc\/UTC|Etc\/GMT)$/i;

const pad2 = (n) => String(Math.abs(n)).padStart(2, '0');

/** Minutes -> "+HH:MM". */
export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad2(Math.floor(Math.abs(minutes) / 60))}:${pad2(Math.abs(minutes) % 60)}`;
}

/**
 * Parse an account timezone string.
 *   { kind: 'offset', minutes, offset: '±HH:MM' }   numeric forms
 *   { kind: 'iana', name }                          names Intl knows
 *   null                                            not understood
 */
export function parseTimezone(tz) {
  const raw = String(tz || '').trim();
  if (!raw) return null;
  if (ZERO_RE.test(raw)) return { kind: 'offset', minutes: 0, offset: '+00:00' };
  const m = OFFSET_RE.exec(raw);
  if (m) {
    const hours = Number(m[2]);
    const mins = Number(m[3] || 0);
    if (hours > 14 || mins > 59) return null;
    const minutes = (m[1] === '-' ? -1 : 1) * (hours * 60 + mins);
    return { kind: 'offset', minutes, offset: formatOffset(minutes) };
  }
  try {
    // Intl validates the name (RangeError otherwise) and canonicalises case.
    const name = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
    return { kind: 'iana', name };
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/** Offset like "-06:00" -> minutes; 0 for IANA names and anything unparseable. */
export function offsetMinutes(tz) {
  const parsed = parseTimezone(tz);
  return parsed?.kind === 'offset' ? parsed.minutes : 0;
}

/** Offset string for a request date param: numeric forms only, '' for IANA/unknown (the API assumes the account zone). */
export function offsetSuffix(tz) {
  const parsed = parseTimezone(tz);
  return parsed?.kind === 'offset' ? parsed.offset : '';
}

const ymdFormatters = new Map();
function ymdFormatter(name) {
  if (!ymdFormatters.has(name)) {
    ymdFormatters.set(name, new Intl.DateTimeFormat('en-CA', { timeZone: name, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return ymdFormatters.get(name);
}

/** The calendar date (YYYY-MM-DD) of `date` in the account timezone; UTC when the zone is not understood. */
export function ymdInTz(date, tz) {
  const parsed = parseTimezone(tz);
  if (parsed?.kind === 'iana') return ymdFormatter(parsed.name).format(date);
  const shifted = new Date(date.getTime() + (parsed?.minutes || 0) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

const timeFormatters = new Map();
function timeFormatter(name) {
  if (!timeFormatters.has(name)) {
    timeFormatters.set(name, new Intl.DateTimeFormat('en-GB', { timeZone: name, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  }
  return timeFormatters.get(name);
}

/** The wall-clock time (HH:MM:SS) of `date` in the account timezone; UTC when the zone is not understood. */
export function timeInTz(date, tz) {
  const parsed = parseTimezone(tz);
  if (parsed?.kind === 'iana') return timeFormatter(parsed.name).format(date).replace(/^24/, '00');
  const shifted = new Date(date.getTime() + (parsed?.minutes || 0) * 60_000);
  return shifted.toISOString().slice(11, 19);
}

/**
 * Request date params. Every documented example carries a time and offset
 * ('2021-04-16T20:35:00-05:00') and list filters are worded as strict
 * bounds, so a bare YYYY-MM-DD may exclude the day itself. Numeric zones
 * get their offset; IANA names get none (the API then assumes the account
 * timezone, which is that zone).
 *
 * The attribution report rejects any bound in the future ("startDate or
 * endDate cannot be in the future"), so when `now` is given and `ymd` is
 * today (or later) in the account zone, dayEnd answers the current
 * wall-clock time in that zone instead of 23:59:59.
 */
export function dayStart(ymd, tz) {
  return `${ymd}T00:00:00${offsetSuffix(tz)}`;
}

export function dayEnd(ymd, tz, now = null) {
  if (now) {
    const today = ymdInTz(now, tz);
    if (ymd >= today) return `${today}T${timeInTz(now, tz)}${offsetSuffix(tz)}`;
  }
  return `${ymd}T23:59:59${offsetSuffix(tz)}`;
}

/* ---------------- legacy response dates ---------------- */

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/**
 * Zone abbreviations the legacy format carries (`zzz` is a Java short zone
 * name, which depends on the account's locale). Ambiguous ones (CST, IST,
 * AMT, …) take their most common reading; anything missing falls back to
 * the account offset.
 */
const ZONES = {
  UTC: '+00:00', GMT: '+00:00', Z: '+00:00', UT: '+00:00', WET: '+00:00', WEST: '+01:00',
  BST: '+01:00', IST: '+05:30', CET: '+01:00', CEST: '+02:00', EET: '+02:00', EEST: '+03:00',
  MSK: '+03:00', SAST: '+02:00', CAT: '+02:00', EAT: '+03:00', WAT: '+01:00',
  GST: '+04:00', PKT: '+05:00', SGT: '+08:00', HKT: '+08:00', JST: '+09:00', KST: '+09:00',
  AWST: '+08:00', ACST: '+09:30', AEST: '+10:00', AEDT: '+11:00', NZST: '+12:00', NZDT: '+13:00',
  EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00', MST: '-07:00', MDT: '-06:00',
  PST: '-08:00', PDT: '-07:00', AKST: '-09:00', AKDT: '-08:00', HST: '-10:00',
  AST: '-04:00', ADT: '-03:00', NST: '-03:30', NDT: '-02:30',
  ART: '-03:00', BRT: '-03:00', BRST: '-02:00', UYT: '-03:00', CLT: '-04:00', CLST: '-03:00',
  PYT: '-04:00', PYST: '-03:00', BOT: '-04:00', PET: '-05:00', COT: '-05:00', ECT: '-05:00', VET: '-04:00',
};

const ISOISH_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/;
const LEGACY_RE = /^(?:[A-Za-z]{3},?\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)\s+(\d{4})$/;
const ZONE_OFFSET_RE = /^(?:UTC|GMT)?([+-])(\d{2}):?(\d{2})$/i;

function zoneOffset(zone, fallback) {
  const key = String(zone || '').toUpperCase();
  if (ZONES[key]) return ZONES[key];
  const m = ZONE_OFFSET_RE.exec(key);
  if (m) return `${m[1]}${m[2]}:${m[3]}`;
  return fallback || '';
}

/**
 * ISO 8601 for a response date: ISO input passes through; the legacy
 * `EEE MMM dd HH:mm:ss zzz yyyy` form ('Thu Nov 17 10:51:54 ART 2022') is
 * rebuilt as local time plus the zone's offset (or `fallbackOffset`, e.g.
 * the account's '-05:00', when the abbreviation is unknown — no suffix when
 * there is none); anything else is null.
 */
export function parseHyrosDate(value, fallbackOffset = '') {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (ISOISH_RE.test(raw)) return raw;
  const m = LEGACY_RE.exec(raw);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[7]}-${month}-${pad2(Number(m[2]))}T${m[3]}:${m[4]}:${m[5]}${zoneOffset(m[6], fallbackOffset)}`;
}

export function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
