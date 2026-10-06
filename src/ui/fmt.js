/**
 * Number, money and date formatting shared by every view, so two views never
 * print the same figure two ways. A missing value prints as '-'.
 */
export const fmt = {
  /* Money keeps the cents the HYROS UI shows. */
  cents: true,
  /* The account's currency (ISO 4217, from data.account().currency). HYROS
     reports every amount in the account currency, so a EUR account must read
     €357.04, not $357.04. app.js sets it once the account is loaded. */
  currency: 'USD',
  /* ISO 4217 codes are three letters. Anything else from the API (or a
     malformed value) falls back to USD so no untrusted string ever reaches
     the DOM through a money cell. */
  currencyCode(code) {
    const c = String(code ?? '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : 'USD';
  },
  money(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    const sign = v < 0 ? '-' : '';
    const digits = fmt.cents ? 2 : 0;
    const abs = Math.abs(v);
    try {
      return sign + new Intl.NumberFormat('en-US', {
        style: 'currency', currency: fmt.currencyCode(fmt.currency), currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(abs);
    } catch {
      // Unknown code: prefix it instead of guessing a symbol.
      return `${sign}${fmt.currencyCode(fmt.currency)} ${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
    }
  },
  /* A record that carries its own currency (a sale in another store currency). Falls back to the account currency. */
  moneyIn(v, code) {
    const safe = fmt.currencyCode(code);
    if (!code || safe === fmt.currency) return fmt.money(v);
    const was = fmt.currency; fmt.currency = safe;
    try { return fmt.money(v); } finally { fmt.currency = was; }
  },
  /* Whole units in the account currency (axis ticks, compact labels). */
  money0(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    const was = fmt.cents; fmt.cents = false;
    try { return fmt.money(v); } finally { fmt.cents = was; }
  },
  int(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    return Math.round(v).toLocaleString('en-US');
  },
  pct(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    return `${v.toFixed(2)}%`;
  },
  ratio(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    return v.toFixed(2);
  },
  date(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },
  datetime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  },
};
