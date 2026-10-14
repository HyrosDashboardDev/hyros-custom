/**
 * Account timezones and HYROS date formats, ported from hyros-ai's selftest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const approx = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

/** The selftest's check, on node:assert: numbers within `tol`, anything else strictly equal. */
function check(name, actual, expected, tol) {
  if (typeof expected === 'number') assert.ok(approx(actual, expected, tol), `${name} (got ${actual}, want ${expected})`);
  else assert.equal(actual, expected, name);
}

test('Timezones the API may send (userProfile.timezone is a free string)', async () => {
  const { parseTimezone, ymdInTz, addDays } = await import('../src/core/dates.js');
  const { buildRanges } = await import('../src/data/report-levels.js');
  const at = new Date('2026-09-15T03:30:00Z');
  check('-05:00 shifts the day back', buildRanges(at, '-05:00').today.start, '2026-09-14');
  check('America/New_York honoured (EDT in September)', buildRanges(at, 'America/New_York').today.start, '2026-09-14');
  check('UTC stays on the UTC day', buildRanges(at, 'UTC').today.start, '2026-09-15');
  check('GMT-5 form', ymdInTz(at, 'GMT-5'), '2026-09-14');
  check('bare -5 form', ymdInTz(at, '-5'), '2026-09-14');
  check('+05:30 rolls forward', ymdInTz(at, '+05:30'), '2026-09-15');
  check('Asia/Kolkata rolls forward', ymdInTz(at, 'Asia/Kolkata'), '2026-09-15');
  check('Mars/Olympus falls back to UTC', buildRanges(at, 'Mars/Olympus').today.start, '2026-09-15');
  check('Mars/Olympus is reported as not understood', parseTimezone('Mars/Olympus'), null);
  check('empty timezone is reported as not understood', parseTimezone(''), null);
  check('numeric offset parses to minutes', parseTimezone('-05:00')?.minutes, -300);
  check('IANA parses as iana', parseTimezone('Europe/Madrid')?.kind, 'iana');
  check('30d window is 30 days wide', buildRanges(at, 'UTC')['30d'].start, addDays('2026-09-15', -29));

  const { dayStart, dayEnd } = await import('../src/core/dates.js');
  check('dayStart with a numeric offset', dayStart('2026-09-14', '-05:00'), '2026-09-14T00:00:00-05:00');
  check('dayEnd with a numeric offset', dayEnd('2026-09-14', '-05:00'), '2026-09-14T23:59:59-05:00');
  check('dayStart with UTC', dayStart('2026-09-14', 'UTC'), '2026-09-14T00:00:00+00:00');
  check('dayStart with an IANA zone carries no offset', dayStart('2026-09-14', 'America/New_York'), '2026-09-14T00:00:00');
  check('dayEnd with an unknown zone carries no offset', dayEnd('2026-09-14', 'Mars/Olympus'), '2026-09-14T23:59:59');
  const noon = new Date('2026-09-14T12:00:00Z');
  check('dayEnd of today is the current local time (the report rejects a future bound)', dayEnd('2026-09-14', '-05:00', noon), '2026-09-14T07:00:00-05:00');
  check('dayEnd of a past day is untouched by now', dayEnd('2026-09-13', '-05:00', noon), '2026-09-13T23:59:59-05:00');
  check('dayEnd of today in UTC', dayEnd('2026-09-14', 'UTC', noon), '2026-09-14T12:00:00+00:00');
  check('dayEnd of today in an IANA zone: local wall clock, no offset', dayEnd('2026-09-13', 'America/New_York', new Date('2026-09-14T02:30:00Z')), '2026-09-13T22:30:00');
  check('dayEnd of a day after today (clock skew) also clamps to now', dayEnd('2026-09-15', '-05:00', noon), '2026-09-14T07:00:00-05:00');
});

test('Legacy dates (sales/calls/subscriptions may use EEE MMM dd HH:mm:ss zzz yyyy)', async () => {
  const { parseHyrosDate } = await import('../src/core/dates.js');
  check('ISO input passes through', parseHyrosDate('2026-09-05T12:00:00-05:00'), '2026-09-05T12:00:00-05:00');
  check('doc example ART -> -03:00', parseHyrosDate('Thu Nov 17 10:51:54 ART 2022'), '2022-11-17T10:51:54-03:00');
  check('doc example UTC', parseHyrosDate('Thu Jul 02 01:10:33 UTC 2026'), '2026-07-02T01:10:33+00:00');
  check('EST / PDT abbreviations', `${parseHyrosDate('Wed Sep 02 10:00:00 EST 2026')} ${parseHyrosDate('Wed Sep 02 10:00:00 PDT 2026')}`, '2026-09-02T10:00:00-05:00 2026-09-02T10:00:00-07:00');
  check('GMT+02:00 style zone', parseHyrosDate('Thu Nov 17 10:51:54 GMT+02:00 2022'), '2022-11-17T10:51:54+02:00');
  check('unknown zone uses the account offset', parseHyrosDate('Thu Nov 17 10:51:54 XYZ 2022', '-05:00'), '2022-11-17T10:51:54-05:00');
  check('unknown zone, no fallback: local time, no offset', parseHyrosDate('Thu Nov 17 10:51:54 XYZ 2022'), '2022-11-17T10:51:54');
  check('single-digit day is zero-padded', parseHyrosDate('Thu Jul 2 01:10:33 UTC 2026'), '2026-07-02T01:10:33+00:00');
  check('garbage is null', parseHyrosDate('yesterday-ish'), null);
  check('null is null', parseHyrosDate(null), null);
  check('empty is null', parseHyrosDate(''), null);
});
