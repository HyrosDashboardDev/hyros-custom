/**
 * Metric definitions, the full HYROS column catalog, and level rollups.
 *
 * Single source of truth: imported by the serverless snapshot builder AND by
 * the browser, so a client-side filter recomputes totals exactly the way the
 * server did.
 *
 * Core formulas were reverse-checked against a real HYROS Performance Report
 * screen (2026-08-13..19):
 *   revenue 560,291.77  reported 900.00  ->  Reported Vs Revenue 559,391.77
 *   meta: cost 4,129.58, revenue 0       ->  profit -4,129.58, ROI -100.00%
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * THE CATALOG: every metric the HYROS attribution report can return, mapped
 * from the `fields` value of GET /attribution to the row key the Report uses.
 * Verified empirically that `fields` drives computation: requested fields
 * populate (0 when no data), unrequested ones are left out of the row.
 *
 *  k    row key (camelCase, after report-levels.js normalizeRow has read the
 *       snake_case key the API publishes; `reported` is read from reported_result)
 *  f    `fields` value of GET /attribution (lowercase, matched exactly)
 *  l    column label
 *  t    money | int | pct | ratio
 *  g    selector group
 *  a    aggregation: 's' additive (sum on rollup) · 'd' derived (re-derive
 *       from additive parts) · null non-aggregatable (native rows only:
 *       rolled-up Campaign/Traffic/Account rows show "-")
 */
// Also never requested: GET /attribution answers 400 to an LTV field on an account without forecasting metrics.
const OFF_LTV = 'HYROS returns 0 for every LTV field today (HMCP-359), so the column is switched off until it is fixed.';

export const CATALOG = [
  // Core
  { k: 'clicks',            f: 'clicks',             l: 'Clicks',            t: 'int',   g: 'Core', a: 's' },
  { k: 'cost',              f: 'cost',               l: 'Cost',              t: 'money', g: 'Core', a: 's' },
  { k: 'totalRevenue',      f: 'total_revenue',      l: 'Total Revenue',     t: 'money', g: 'Core', a: 's' },
  { k: 'revenue',           f: 'revenue',            l: 'Revenue',           t: 'money', g: 'Core', a: 's' },
  { k: 'profit',            f: 'profit',             l: 'Profit',            t: 'money', g: 'Core', a: 'd', tone: true },
  { k: 'reported',          f: 'reported_result',    l: 'Reported',          t: 'money', g: 'Core', a: 's' },
  { k: 'reportedVsRevenue', f: 'reported_vs_revenue', l: 'Reported Vs Rev',   t: 'money', g: 'Core', a: 'd', tone: true },
  { k: 'shopReportedResult',f: 'shop_reported_result', l: 'Shop Reported',    t: 'money', g: 'Core', a: 's' },
  { k: 'sales',             f: 'sales',              l: 'Sales',             t: 'int',   g: 'Core', a: 's' },
  { k: 'uniqueSales',       f: 'unique_sales',       l: 'Unique Sales',      t: 'int',   g: 'Core', a: 's' },
  { k: 'roi',               f: 'roi',                l: 'ROI',               t: 'pct',   g: 'Core', a: 'd', tone: true },
  { k: 'roas',              f: 'roas',               l: 'ROAS',              t: 'ratio', g: 'Core', a: 'd' },
  { k: 'leads',             f: 'leads',              l: 'Leads',             t: 'int',   g: 'Core', a: 's' },
  { k: 'newLeads',          f: 'new_leads',          l: 'New Leads',         t: 'int',   g: 'Core', a: 's' },
  { k: 'leadsOptins',       f: 'leads_optins',       l: 'Opt-ins',           t: 'int',   g: 'Core', a: 's' },
  { k: 'impressions',       f: 'impressions',        l: 'Impressions',       t: 'int',   g: 'Core', a: 's' },
  { k: 'ctr',               f: 'ctr',                l: 'CTR',               t: 'pct',   g: 'Core', a: 'd' },
  { k: 'cpm',               f: 'cpm',                l: 'CPM',               t: 'money', g: 'Core', a: 'd' },
  { k: 'cvr',               f: 'cvr',                l: 'CVR',               t: 'pct',   g: 'Core', a: 'd' },
  { k: 'newVisits',         f: 'new_visits',         l: 'New Visits',        t: 'int',   g: 'Core', a: 's' },
  { k: 'partialVideoViews', f: 'partial_video_views', l: 'Video Views (3s)',  t: 'int',   g: 'Core', a: 's' },

  // Cost per …
  { k: 'costPerClick',            f: 'cost_per_click',             l: 'Cost / Click',        t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerLead',             f: 'cost_per_lead',              l: 'Cost / Lead',         t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerNewLead',          f: 'cost_per_new_lead',          l: 'Cost / New Lead',     t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerSale',             f: 'cost_per_sale',              l: 'Cost / Sale',         t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerUniqueSales',      f: 'cost_per_unique_sale',       l: 'Cost / Unique Sale',  t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerCall',             f: 'cost_per_call',              l: 'Cost / Call',         t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerQualifiedCall',    f: 'cost_per_qualified_call',    l: 'Cost / Qual. Call',   t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerUniqueCall',       f: 'cost_per_unique_call',       l: 'Cost / Unique Call',  t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerNewVisit',         f: 'cost_per_new_visit',         l: 'Cost / New Visit',    t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerUniqueCustomer',   f: 'cost_per_unique_customer',   l: 'Cost / Unique Cust.', t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerNewSubscriptions', f: 'cost_per_new_subscriptions', l: 'Cost / New Sub',      t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerNewTrials',        f: 'cost_per_new_trials',        l: 'Cost / New Trial',    t: 'money', g: 'Cost per', a: 'd' },
  { k: 'costPerAtc',              f: 'cost_per_atc',               l: 'Cost / ATC',          t: 'money', g: 'Cost per', a: 'd' },
  { k: 'cac',                     f: 'cac',                        l: 'CAC',                 t: 'money', g: 'Cost per', a: null },

  // Calls
  { k: 'calls',            f: 'calls',             l: 'Calls',            t: 'int', g: 'Calls', a: 's' },
  { k: 'qualifiedCalls',   f: 'qualified_calls',   l: 'Qualified Calls',  t: 'int', g: 'Calls', a: 's' },
  { k: 'unqualifiedCalls', f: 'unqualified_calls', l: 'Unqual. Calls',    t: 'int', g: 'Calls', a: 's' },
  { k: 'uniqueCalls',      f: 'unique_calls',      l: 'Unique Calls',     t: 'int', g: 'Calls', a: 's' },
  { k: 'canceledCalls',    f: 'canceled_calls',    l: 'Canceled Calls',   t: 'int', g: 'Calls', a: 's' },
  { k: 'noShowCalls',      f: 'no_show_calls',     l: 'No-show Calls',    t: 'int', g: 'Calls', a: 's' },

  // Customers
  { k: 'customers',                    f: 'customers',                      l: 'Customers',           t: 'int',   g: 'Customers', a: 's' },
  { k: 'uniqueCustomers',              f: 'unique_customers',               l: 'Unique Customers',    t: 'int',   g: 'Customers', a: 's' },
  { k: 'totalCustomers',               f: 'total_customers',                l: 'Total Customers',     t: 'int',   g: 'Customers', a: 's' },
  { k: 'recurringCustomers',           f: 'recurring_customers',            l: 'Recurring Customers', t: 'int',   g: 'Customers', a: 's' },
  { k: 'returningCustomers',           f: 'returning_customers',            l: 'Returning Customers', t: 'int',   g: 'Customers', a: 's' },
  { k: 'newCustomersOrders',           f: 'new_customers_orders',           l: 'New Cust. Orders',    t: 'int',   g: 'Customers', a: 's' },
  { k: 'uniqueCustomersRevenue',       f: 'unique_customers_revenue',       l: 'Unique Cust. Revenue',t: 'money', g: 'Customers', a: 's' },
  { k: 'returningCustomersRevenue',    f: 'returning_customers_revenue',    l: 'Returning Cust. Rev', t: 'money', g: 'Customers', a: 's' },
  { k: 'averageOrderValue',            f: 'aov',                            l: 'AOV',                 t: 'money', g: 'Customers', a: 'd' },
  { k: 'newCustomersPercentage',       f: 'new_customers_percentage',       l: 'New Cust. %',         t: 'pct',   g: 'Customers', a: null },
  { k: 'recurringCustomersPercentage', f: 'recurring_customers_percentage', l: 'Recurring Cust. %',   t: 'pct',   g: 'Customers', a: null },
  { k: 'returningCustomersRate',       f: 'returning_customers_rate',       l: 'Returning Rate',      t: 'pct',   g: 'Customers', a: null },
  { k: 'returningCustomersRevenueRate',f: 'returning_customers_revenue_rate', l: 'Returning Rev Rate', t: 'pct',   g: 'Customers', a: null },
  { k: 'newCustomersRoas',             f: 'new_customers_roas',             l: 'New Cust. ROAS',      t: 'ratio', g: 'Customers', a: null },
  { k: 'newCustomersAov',              f: 'new_customers_aov',              l: 'New Cust. AOV',       t: 'money', g: 'Customers', a: null },

  // Revenue detail
  { k: 'recurringRevenue',          f: 'recurring_revenue',           l: 'Recurring Revenue', t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'oneTimeSales',              f: 'one_time_sales',              l: 'One-time Sales',    t: 'int',   g: 'Revenue detail', a: 's' },
  { k: 'refund',                    f: 'refund',                      l: 'Refunded $',        t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'refundCount',               f: 'refund_count',                l: 'Refunds',           t: 'int',   g: 'Revenue detail', a: 's' },
  { k: 'refundedSalesPercentage',   f: 'refunded_sales_percentage',   l: 'Refunded Sales %',  t: 'pct',   g: 'Revenue detail', a: 'd' },
  { k: 'refundedRevenuePercentage', f: 'refunded_revenue_percentage', l: 'Refunded Rev %',    t: 'pct',   g: 'Revenue detail', a: 'd' },
  { k: 'hardCosts',                 f: 'hard_costs',                  l: 'Hard Costs',        t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'taxes',                     f: 'taxes',                       l: 'Taxes',             t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'costOfGoods',               f: 'cost_of_goods',               l: 'Cost of Goods',     t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'shippingValue',             f: 'shipping_value',              l: 'Shipping',          t: 'money', g: 'Revenue detail', a: 's' },
  { k: 'netProfit',                 f: 'net_profit',                  l: 'Net Profit',        t: 'money', g: 'Revenue detail', a: null, tone: true },
  { k: 'netProfitPercentage',       f: 'net_profit_percentage',       l: 'Net Profit %',      t: 'pct',   g: 'Revenue detail', a: null, tone: true },
  { k: 'grossMargins',              f: 'gross_margins',               l: 'Gross Margin',      t: 'pct',   g: 'Revenue detail', a: null },
  { k: 'contributionProfit',        f: 'contribution_profit',         l: 'Contribution Profit',t:'money', g: 'Revenue detail', a: null, tone: true },
  { k: 'contributionMargin',        f: 'contribution_margin',         l: 'Contribution Margin',t:'pct',   g: 'Revenue detail', a: null },

  // Subscriptions & trials
  { k: 'newSubscriptions',      f: 'new_subscriptions',      l: 'New Subs',       t: 'int',   g: 'Subscriptions', a: 's' },
  { k: 'canceledSubscriptions', f: 'canceled_subscriptions', l: 'Canceled Subs',  t: 'int',   g: 'Subscriptions', a: 's' },
  { k: 'directSubscriptions',   f: 'direct_subscriptions',   l: 'Direct Subs',    t: 'int',   g: 'Subscriptions', a: 's' },
  { k: 'mrr',                   f: 'mrr',                    l: 'MRR',            t: 'money', g: 'Subscriptions', a: 's' },
  { k: 'newMRR',                f: 'new_mrr',                l: 'New MRR',        t: 'money', g: 'Subscriptions', a: 's' },
  { k: 'arr',                   f: 'arr',                    l: 'ARR',            t: 'money', g: 'Subscriptions', a: 's' },
  { k: 'churnRate',             f: 'churn_rate',             l: 'Churn Rate',     t: 'pct',   g: 'Subscriptions', a: null },
  { k: 'newTrials',             f: 'new_trials',             l: 'New Trials',     t: 'int',   g: 'Subscriptions', a: 's' },
  { k: 'convertedTrials',       f: 'converted_trials',       l: 'Converted Trials',t: 'int',  g: 'Subscriptions', a: 's' },
  { k: 'canceledTrials',        f: 'canceled_trials',        l: 'Canceled Trials',t: 'int',   g: 'Subscriptions', a: 's' },

  // LTV & forecasts: per-customer values; never summable across sources.
  // `off`: not requested and not selectable while HYROS returns 0 for them.
  { k: 'ltv30Days',   f: '30_days_ltv',   l: 'LTV 30d',  t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltv60Days',   f: '60_days_ltv',   l: 'LTV 60d',  t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltv90Days',   f: '90_days_ltv',   l: 'LTV 90d',  t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltv6Months',  f: '6_months_ltv',  l: 'LTV 6mo',  t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltv1Year',    f: '1_year_ltv',    l: 'LTV 1yr',  t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltvForecast30Days',  f: '30_days_ltv_forecast',  l: 'LTV 30d (fcst)', t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltvForecast60Days',  f: '60_days_ltv_forecast',  l: 'LTV 60d (fcst)', t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltvForecast90Days',  f: '90_days_ltv_forecast',  l: 'LTV 90d (fcst)', t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltvForecast6Months', f: '6_months_ltv_forecast', l: 'LTV 6mo (fcst)', t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'ltvForecast1Year',   f: '1_year_ltv_forecast',   l: 'LTV 1yr (fcst)', t: 'money', g: 'LTV & forecasts', a: null, off: OFF_LTV },
  { k: 'subscription30DaysForecast', f: 'subscription_30_days_forecast', l: 'Sub Rev 30d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription60DaysForecast', f: 'subscription_60_days_forecast', l: 'Sub Rev 60d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription90DaysForecast', f: 'subscription_90_days_forecast', l: 'Sub Rev 90d (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription6MonthsForecast', f: 'subscription_6_months_forecast', l: 'Sub Rev 6mo (fcst)', t: 'money', g: 'LTV & forecasts', a: null },
  { k: 'subscription1YearForecast',  f: 'subscription_1_year_forecast',  l: 'Sub Rev 1yr (fcst)', t: 'money', g: 'LTV & forecasts', a: null },

  // Ecom / carts
  { k: 'carts',          f: 'carts',                l: 'Carts',          t: 'int', g: 'Ecom', a: 's' },
  { k: 'atcEvents',      f: 'atc_events',           l: 'ATC Events',     t: 'int', g: 'Ecom', a: 's' },
  { k: 'purchasedCarts', f: 'purchased_carts',      l: 'Purchased Carts',t: 'int', g: 'Ecom', a: 's' },
  { k: 'atcCvr',         f: 'atc_cvr',              l: 'Cart CVR',       t: 'pct', g: 'Ecom', a: 'd' },
  { k: 'atcRate',        f: 'atc_rate',             l: 'ATC Rate',       t: 'pct', g: 'Ecom', a: null },

  // Attribution timing
  { k: 'timeOfConversionAttributionAvg', f: 'time_of_sale_attribution', l: 'Days to Sale (avg)', t: 'ratio', g: 'Attribution', a: null },
  { k: 'timeOfCallAttributionAvg',       f: 'time_of_call_attribution', l: 'Days to Call (avg)', t: 'ratio', g: 'Attribution', a: null },
];

export const CATALOG_BY_KEY = new Map(CATALOG.map((c) => [c.k, c]));

/** Default visible columns, the Basic-preset set the dashboard launched with. */
export const DEFAULT_KEYS = [
  'clicks', 'cost', 'totalRevenue', 'revenue', 'profit', 'reported',
  'reportedVsRevenue', 'sales', 'roi', 'roas', 'calls', 'leads',
  'costPerLead', 'impressions', 'ctr', 'cpm',
];

/** Metrics that are safe to sum when rolling child rows into a parent. */
export const ADDITIVE = CATALOG.filter((c) => c.a === 's').map((c) => c.k);

const ratio = (a, b) => (num(b) === 0 ? null : num(a) / num(b));
const pct100 = (a, b) => (num(b) === 0 ? null : (num(a) / num(b)) * 100);

/**
 * Extended derived metrics: computed only when the API did not supply a value
 * (rolled-up rows), so native ad-set/ad rows keep HYROS's own numbers.
 */
const RATIOS = {
  costPerClick:            (r) => ratio(r.cost, r.clicks),
  costPerLead:             (r) => ratio(r.cost, r.leads),
  costPerNewLead:          (r) => ratio(r.cost, r.newLeads),
  costPerSale:             (r) => ratio(r.cost, r.sales),
  costPerUniqueSales:      (r) => ratio(r.cost, r.uniqueSales),
  costPerCall:             (r) => ratio(r.cost, r.calls),
  costPerQualifiedCall:    (r) => ratio(r.cost, r.qualifiedCalls),
  costPerUniqueCall:       (r) => ratio(r.cost, r.uniqueCalls),
  costPerNewVisit:         (r) => ratio(r.cost, r.newVisits),
  costPerUniqueCustomer:   (r) => ratio(r.cost, r.uniqueCustomers),
  costPerNewSubscriptions: (r) => ratio(r.cost, r.newSubscriptions),
  costPerNewTrials:        (r) => ratio(r.cost, r.newTrials),
  costPerAtc:              (r) => ratio(r.cost, r.atcEvents),
  averageOrderValue:       (r) => ratio(r.revenue, r.sales),
  cvr:                     (r) => pct100(r.sales, r.clicks),
  refundedSalesPercentage: (r) => pct100(r.refundCount, r.sales),
  refundedRevenuePercentage:(r) => pct100(r.refund, r.revenue),
  atcCvr:                  (r) => pct100(r.purchasedCarts, r.carts),
};

/**
 * Recompute every derived metric from the additive base.
 * Never average a derived metric across children, always re-derive.
 * The verified core set is always recomputed; extended ratios only fill
 * gaps so native API values are preserved.
 */
export function derive(row) {
  const cost = num(row.cost);
  const revenue = num(row.revenue);
  // Revenue is one-time sales only; totalRevenue adds rebills and is what HYROS's ROAS
  // counts, so profit/ROI/ROAS all use it. A missing or zeroed total falls back to revenue
  // and is written back so the Total Revenue tile agrees with them.
  const totalRevenue = num(row.totalRevenue) === 0 ? revenue : num(row.totalRevenue);
  const impressions = num(row.impressions);

  const out = {
    ...row,
    totalRevenue,
    profit: totalRevenue - cost,
    roas: cost === 0 ? null : totalRevenue / cost,
    roi: cost === 0 ? null : ((totalRevenue - cost) / cost) * 100,
    reportedVsRevenue: revenue - num(row.reported),
    ctr: impressions === 0 ? null : (num(row.clicks) / impressions) * 100,
    cpm: impressions === 0 ? null : (cost / impressions) * 1000,
    cpl: ratio(cost, row.leads),
    cps: ratio(cost, row.sales),
    cpc: ratio(cost, row.clicks),
  };

  for (const [key, fn] of Object.entries(RATIOS)) {
    if (out[key] === null || out[key] === undefined) {
      const v = fn(out);
      if (v !== null) out[key] = v;
    }
  }
  return out;
}

/** Sum a set of rows into one row, then re-derive. */
export function aggregate(rows, seed = {}) {
  const base = { ...seed };
  for (const key of ADDITIVE) base[key] = 0;
  for (const row of rows) {
    for (const key of ADDITIVE) base[key] += num(row[key]);
  }
  return derive(base);
}

/**
 * Group rows by a key and roll each group up.
 * `keyOf` returns null to drop a row from this level.
 */
export function rollup(rows, keyOf, labelOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([id, group]) =>
    aggregate(group, { id, name: labelOf(id, group), children: group.length }),
  );
}
