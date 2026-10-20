/**
 * Scale: reading and drawing one marginal CAC curve. normalizeCurve, curveSvg,
 * curveVerdict and NOTE_WORD come from hyros-ai (features/scale) unchanged
 * except for the class names (prefixed `scale-`) and the dash-free wording.
 *
 * Documented reply (GET /attribution/marginal-cac-curve, MarginalCacCurveResponseDTO),
 * inside the `{ request_id, result }` envelope:
 *   { id, level, name, startDate, endDate, attributionModel, daysSampled,
 *     cacCeiling, ceilingBasis: CALLER_PROVIDED | LTV_BREAKEVEN, ltvWindow,
 *     curve: [{ spendPerDay, days, newCustomers, avgCac, marginalCac }],
 *     saturationPoint: { efficientSpendPerDay, saturatedSpendPerDay, reason } | null,
 *     notes: [NO_SPEND_DATA | NO_CUSTOMERS | INSUFFICIENT_DATA | LTV_CEILING_UNAVAILABLE] }
 * Older key spellings are still read as fallbacks.
 */

export const NOTE_WORD = {
  NO_SPEND_DATA: 'No spend history in the window',
  NO_CUSTOMERS: 'No customers attributed in the window',
  INSUFFICIENT_DATA: 'Not enough spend history to build a curve',
  LTV_CEILING_UNAVAILABLE: 'No LTV ceiling available for this entity',
};

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const pickNum = (obj, keys) => { for (const k of keys) { const v = num(obj?.[k]); if (v !== null) return v; } return null; };
const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The curve inside the `{ request_id, result }` envelope; a bare curve is read as it is. */
const unwrap = (raw) => (isMap(raw) && isMap(raw.result) && !Array.isArray(raw.curve) ? raw.result : raw);

/** Normalize one GET /attribution/marginal-cac-curve response (documented keys first, legacy keys as fallbacks). */
export function normalizeCurve(rawReply, meta) {
  const raw = unwrap(rawReply);
  const points = (Array.isArray(raw?.curve) ? raw.curve : [])
    .map((p) => ({
      spend: pickNum(p, ['spendPerDay', 'dailySpend', 'spend', 'spendLevel', 'x']),
      days: pickNum(p, ['days']),
      customers: pickNum(p, ['newCustomers', 'customers', 'conversions']),
      avgCac: pickNum(p, ['avgCac', 'averageCac', 'cac', 'average']),
      marginalCac: pickNum(p, ['marginalCac', 'marginal', 'mcac']),
    }))
    .filter((p) => p.spend !== null)
    .sort((a, b) => a.spend - b.spend);
  const sat = raw?.saturationPoint ?? raw?.saturation ?? null;
  const saturationSpend = isMap(sat) ? pickNum(sat, ['saturatedSpendPerDay', 'dailySpend', 'spend', 'spendLevel']) : num(sat);
  const efficientSpend = isMap(sat) ? pickNum(sat, ['efficientSpendPerDay']) : null;
  return {
    ...meta,
    name: (typeof raw?.name === 'string' && raw.name) || meta?.name || null,
    attributionModel: raw?.attributionModel || null,
    daysSampled: num(raw?.daysSampled) ?? 0,
    ceiling: num(raw?.cacCeiling),
    ceilingBasis: raw?.ceilingBasis || null,
    ltvWindow: raw?.ltvWindow || null,
    saturationSpend,
    efficientSpend,
    saturationReason: isMap(sat) && sat.reason ? String(sat.reason) : null,
    points,
    notes: Array.isArray(raw?.notes) ? raw.notes.map(String) : [],
  };
}

/** Thin curve: few spend levels, a level with no customers, or HYROS said so. Worth a warning even when `notes` is empty. */
export function isThin(c) {
  const points = c?.points || [];
  if (!points.length) return false;
  if ((c.notes || []).includes('INSUFFICIENT_DATA')) return true;
  return points.length <= 3 || points.some((p) => !p.customers);
}

/** Inline SVG: average + marginal CAC vs daily spend, ceiling and saturation lines. Geometry only; strokes come from style.css. */
export function curveSvg(c, fmt) {
  const W = 520, H = 160, L = 0, R = 0, T = 4, B = 0;
  const pts = c.points.filter((p) => p.spend !== null);
  if (pts.length < 2) return '';
  const xs = pts.map((p) => p.spend);
  const ys = pts.flatMap((p) => [p.avgCac, p.marginalCac]).filter((v) => v !== null);
  if (c.ceiling) ys.push(c.ceiling);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  if (!ys.length) return ''; // spend points but no CAC values: nothing to plot
  const yMax = Math.max(...ys) * 1.1 || 1;
  const X = (v) => L + ((v - xMin) / ((xMax - xMin) || 1)) * (W - L - R);
  const Y = (v) => T + (1 - v / yMax) * (H - T - B);
  const path = (key) => pts.filter((p) => p[key] !== null)
    .map((p, i) => `${i ? 'L' : 'M'}${X(p.spend).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ');
  const ticksY = [0, 0.5, 1].map((f) => f * yMax);
  const ticksX = [xMin, (xMin + xMax) / 2, xMax];
  const sat = c.saturationSpend;
  // The SVG holds only geometry and stretches to the card (preserveAspectRatio
  // none + non-scaling strokes); axis labels are HTML next to it, so text is
  // never distorted whatever the card width.
  const money = (n) => fmt.money0(n); // axis ticks in the account currency
  return `<div class="scale-plot">
    <div class="scale-ylabels">${[...ticksY].reverse().map((t) => `<span>${money(t)}</span>`).join('')}</div>
    <svg class="scale-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="CAC curve">
    ${ticksY.map((t) => `<line class="scale-grid" vector-effect="non-scaling-stroke" x1="0" x2="${W}" y1="${Y(t)}" y2="${Y(t)}"/>`).join('')}
    <line class="scale-axis" vector-effect="non-scaling-stroke" x1="0" x2="${W}" y1="${H}" y2="${H}"/>
    ${c.ceiling ? `<line class="scale-ceil" vector-effect="non-scaling-stroke" x1="0" x2="${W}" y1="${Y(c.ceiling)}" y2="${Y(c.ceiling)}"/>` : ''}
    ${sat !== null && sat !== undefined && sat >= xMin && sat <= xMax
      ? `<line class="scale-sat" vector-effect="non-scaling-stroke" x1="${X(sat)}" x2="${X(sat)}" y1="0" y2="${H}"/>` : ''}
    <path class="scale-avg" vector-effect="non-scaling-stroke" d="${path('avgCac')}"/>
    <path class="scale-marg" vector-effect="non-scaling-stroke" d="${path('marginalCac')}"/>
  </svg>
    <div class="scale-xlabels">${ticksX.map((t) => `<span>${money(t)}/day</span>`).join('')}</div>
  </div>
  <div class="scale-legend"><span><i></i>Average CAC</span><span><i class="scale-marg"></i>Marginal CAC (next customer)</span>
    ${c.ceiling ? '<span><i class="scale-ceil"></i>CAC ceiling</span>' : ''}${sat !== null && sat !== undefined ? '<span><i class="scale-sat"></i>Saturation</span>' : ''}</div>`;
}

/** The one-line verdict of a card: { cls: good | bad | '', text }. */
export function curveVerdict(c, fmt) {
  if (c.error) return { cls: 'bad', text: 'Curve unavailable' };
  if (c.skipped) return { cls: '', text: `Skipped: ${c.skipped}` };
  if (c.pending) return { cls: '', text: 'Loading curve' };
  const points = c.points || [];
  if (points.length < 2) {
    const note = (c.notes || []).find((n) => NOTE_WORD[n]);
    return { cls: '', text: note ? NOTE_WORD[note] : 'Not enough data yet' };
  }
  const last = points[points.length - 1];
  const current = points.reduce((m, p) => (p.customers !== null && p.customers > (m?.customers ?? -1) ? p : m), null);
  const sat = c.saturationSpend ?? null;
  if (sat === null) {
    const why = c.ceiling === null || c.ceiling === undefined ? ' (no CAC ceiling at this level)' : ', no saturation found';
    return { cls: 'good', text: `Still efficient at ${fmt.money(last.spend)}/day${why}` };
  }
  const headroom = sat - (current?.spend ?? last.spend);
  return headroom > 0
    ? { cls: 'good', text: `Saturates at ${fmt.money(sat)}/day` }
    : { cls: 'bad', text: `Past saturation (${fmt.money(sat)}/day): next dollar costs more than the ceiling` };
}
