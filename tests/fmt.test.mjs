/**
 * Money formatting follows the account currency and never emits an
 * unvalidated currency string. Ported from hyros-ai's selftest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const approx = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

/** The selftest's check, on node:assert: numbers within `tol`, anything else strictly equal. */
function check(name, actual, expected, tol) {
  if (typeof expected === 'number') assert.ok(approx(actual, expected, tol), `${name} (got ${actual}, want ${expected})`);
  else assert.equal(actual, expected, name);
}

test('Formatting: money follows the account currency', async () => {
  const { fmt } = await import('../src/ui/fmt.js');
  const was = { cents: fmt.cents, currency: fmt.currency };
  fmt.cents = true; fmt.currency = 'USD';
  check('fmt.money follows the account currency: USD', fmt.money(357.04), '$357.04');
  fmt.currency = 'EUR';
  check('fmt.money follows the account currency: EUR', fmt.money(357.04), '€357.04');
  check('fmt.money keeps the sign in front of the symbol', fmt.money(-96.45), '-€96.45');
  fmt.currency = 'XYZ';
  check('fmt.money with an unknown code prefixes the code', fmt.money(1234.5).startsWith('XYZ') && fmt.money(1234.5).endsWith('1,234.50'), true);
  fmt.cents = false; fmt.currency = 'USD';
  check('fmt.money hides cents on the demo', fmt.money(1234.5), '$1,235');
  fmt.cents = true;
  check('fmt.currencyCode accepts ISO codes only', [fmt.currencyCode('eur'), fmt.currencyCode('MXN'), fmt.currencyCode('<img src=x>'), fmt.currencyCode(null), fmt.currencyCode('US')].join(','), 'EUR,MXN,USD,USD,USD');
  fmt.currency = '<img src=x onerror=alert(1)>';
  check('fmt.money never emits an unvalidated currency string', fmt.money(5).includes('<'), false);
  check('fmt.moneyIn ignores a malformed per-record code', fmt.moneyIn(5, '<b>').includes('<'), false);
  fmt.cents = true; fmt.currency = 'EUR';
  check('fmt.moneyIn formats a record in its own currency', fmt.moneyIn(288, 'USD'), '$288.00');
  check('fmt.moneyIn falls back to the account currency', fmt.moneyIn(288, null), '€288.00');
  check('fmt.moneyIn leaves the account currency untouched afterwards', fmt.money(1), '€1.00');
  fmt.cents = was.cents; fmt.currency = was.currency;
});
