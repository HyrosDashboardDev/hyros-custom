/**
 * Health: is the HYROS script on the sites, and do the Google ad links carry
 * the tracking parameters. Every tile and panel says what its check did this
 * render (ok | empty | skipped | failed, with the reason), so a "-" is never
 * left unexplained and no empty state is invented. Contract: SPEC.md.
 *
 * ctx = { root, data, fmt, esc, kpis, now }
 */
import { ymdInTz } from '../../core/dates.js';
import { VIEW_LOAD_MS } from '../../core/budget.js';
import { runChecks, groupSites, siteSummary, isFlagged, hasGoogleAccount, PENDING, MAX_PARAM_ROWS } from './checks.js';

const DEADLINE_MARGIN_MS = 15000;
const CHECK_NAME = { domains: 'verified domains', params: 'tracking params', script: 'script presence', visits: 'recent visits' };
const STATUS_PILL = { ok: 'ok', empty: '', skipped: 'warn', failed: 'bad', pending: '' };
const SKIP_LINE = {
  'time budget': 'Skipped (time budget): press Refresh to try again.',
  'no verified domains': 'No verified domains on this account: add one in HYROS.',
  'domains check failed': 'Skipped: the domain list could not be fetched (see Check errors).',
  'no Google ad accounts connected': 'No Google ad accounts connected, nothing to check.',
};
const MAX_SUB_CHARS = 48;

/** Bumped on every render: the series of an older render stops before its next call. */
let renderSeq = 0;

/** A failure reason short enough for a KPI sub: the first clause, capped. */
export function shortReason(reason) {
  const clause = String(reason || '').split(' (')[0].trim();
  return clause.length > MAX_SUB_CHARS ? `${clause.slice(0, MAX_SUB_CHARS - 3)}...` : clause;
}

/** The status line for a check that produced no rows to show. */
function statusLine(check) {
  if (check.status === 'pending') return 'Running...';
  if (check.status === 'failed') return `Check failed: ${check.reason || 'unknown error'}`;
  if (check.status === 'skipped') return SKIP_LINE[check.reason] || `Skipped: ${check.reason || 'unknown reason'}.`;
  return null;
}

/** KPI sub for a check that is not ok, in the tile's mono voice. */
function checkSub(check, emptyText) {
  if (check.status === 'pending') return 'running';
  if (check.status === 'skipped') return check.reason === 'time budget' ? 'skipped: time budget' : (check.reason || 'skipped');
  if (check.status === 'failed') return `failed: ${shortReason(check.reason)}`;
  return emptyText;
}

/** Which channels the params check covered: "checked: A, B" or per-channel outcomes when they differ. */
function channelsSub(check, fallback) {
  const entries = Object.entries(check.channels || {});
  if (!entries.length) return fallback;
  const ran = (s) => s === 'ok' || s === 'empty';
  if (entries.every(([, s]) => ran(s))) return `checked: ${entries.map(([t]) => t).join(', ')}`;
  return entries.map(([t, s]) => `${t} ${ran(s) ? 'checked' : s}`).join(' · ');
}

const statusRow = (check, esc, text) => `<div class="health-status"><span class="pill ${STATUS_PILL[check.status] || ''}">${esc(check.status)}</span><span class="health-msg">${esc(text)}</span></div>`;

/** The checks that failed, as "name: message" lines. */
export function errorsOf(h) {
  const out = [];
  for (const [id, c] of Object.entries(h.checks)) if (c.status === 'failed') out.push(`${CHECK_NAME[id] || id}: ${c.reason || 'unknown error'}`);
  return out;
}

/** "Checks": one row per check with its status, reason and duration. */
function checksPanel(h, fmt, esc) {
  const { checks } = h;
  const detail = {
    domains: checks.domains.status === 'ok' ? `${fmt.int(h.domains.length)} verified` : '',
    script: checks.script.status === 'ok' ? `${fmt.int(Object.keys(h.scripts).length)} URLs fetched` : '',
    params: checks.params.status === 'ok' || checks.params.status === 'empty' ? channelsSub(checks.params, '') : '',
    visits: checks.visits.status === 'ok' ? `visits on ${fmt.int(h.visitedHosts.length)} hosts in 7 days` : '',
  };
  // A visits check skipped because nothing needed confirming is not worth amber.
  const pillOf = (id, c) => (id === 'visits' && c.status === 'skipped' ? '' : STATUS_PILL[c.status] || '');
  const text = (id, c) => {
    if (c.status === 'pending') return c.reason || 'running';
    const base = c.status === 'ok' || c.status === 'empty' ? detail[id] || (c.status === 'empty' ? 'ran, nothing found' : '') : '';
    return [base, c.reason].filter(Boolean).join('; ');
  };
  return `<div class="fpanel"><h3>Checks</h3>
    <div class="fhint">what each HYROS check did in this load: a skip is not an error, a failure is</div>
    ${Object.entries(checks).map(([id, c]) => `<div class="health-row"><span class="pill ${pillOf(id, c)}">${esc(c.status)}</span><code>${esc(CHECK_NAME[id] || id)}</code>
      <span class="health-msg">${esc(text(id, c))}</span>
      ${Number.isFinite(c.ms) ? `<span class="sub">${esc(`${(c.ms / 1000).toFixed(1)} s`)}</span>` : ''}</div>`).join('')}
  </div>`;
}

/** Every error, full size: a bad pill with the check name, then its message. */
function errorsPanel(errors, esc) {
  return `<div class="fpanel health-errors"><h3>Check errors</h3>
    <div class="fhint">each line is one check's own message from this load</div>
    ${errors.map((e) => {
      const i = e.indexOf(': ');
      const name = i > 0 ? e.slice(0, i) : 'check';
      const msg = i > 0 ? e.slice(i + 2) : e;
      return `<div class="health-row"><span class="pill bad">${esc(name)}</span><span class="health-msg">${esc(msg)}</span></div>`;
    }).join('')}
  </div>`;
}

const statusWords = (st) => String(st).toLowerCase().replace(/_/g, ' ');

function siteRow(g, esc) {
  const pill = g.inconclusive ? `<span class="pill warn">couldn&#39;t check (${esc(g.timedOut ? 'timeout' : statusWords(g.variants.find((v) => v.status !== null)?.status))})</span>`
    : !g.checked ? '<span class="pill">not checked</span>'
    : g.visited ? '<span class="pill warn">not detected · visits tracked</span>'
    : g.found ? `<span class="pill ok">script found${g.foundOn.some((u) => /\/\/www\./.test(u)) && !g.foundOn.some((u) => !/\/\/www\./.test(u)) ? ' (on www)' : ''}</span>`
    : '<span class="pill bad">script not found</span>';
  const variants = g.variants.map((v) => `<span class="sub">${esc(v.url)} · ${esc(v.status === null ? 'not checked' : statusWords(v.status))}</span>`).join('');
  return `<div class="health-row health-site"><code title="${esc(g.site)}">${esc(g.site)}</code>
    <span class="sub">tracking domain ${esc(g.trackingDomain)}</span>
    ${pill}</div><div class="health-variants">${variants}</div>`;
}

/** The whole tab for one state of the block. */
export function html(ctx, h, { adAccounts, account }) {
  const { fmt, esc, kpis } = ctx;
  const { checks } = h;
  const hasGoogle = hasGoogleAccount(adAccounts);
  const scripts = Object.entries(h.scripts);
  const groups = groupSites(h.sites, h.scripts, h.visitedHosts);
  const sum = siteSummary(groups);
  const plural = (n, w) => `${fmt.int(n)} ${w}${n === 1 ? '' : 's'}`;
  const scriptReady = checks.script.status === 'ok' && scripts.length > 0;
  const sitesValue = sum.checked ? `${fmt.int(sum.ok)} / ${fmt.int(sum.checked)}` : '-';
  const sitesCls = sum.missing ? 'bad' : (!sum.checked || sum.unsure ? '' : 'good');
  const sitesSub = sum.checked
    ? `of ${plural(sum.checked, 'site')} checked (${fmt.int(scripts.length)} URLs)${sum.inconclusive ? ` · ${plural(sum.inconclusive, 'site')} couldn't be checked` : ''}`
    : `${plural(sum.inconclusive, 'site')} couldn't be checked`;
  const paramRows = h.trackingParams.flatMap((p) => (p.rows || []).map((r) => ({ ...r, _type: p.type })));
  const flagged = paramRows.filter(isFlagged);
  const paramsReady = checks.params.status === 'ok' && paramRows.length > 0;
  const errors = errorsOf(h);
  const running = Object.values(checks).some((c) => c.status === 'pending');

  const tiles = kpis([
    { label: 'Verified domains', value: checks.domains.status === 'ok' || checks.domains.status === 'empty' ? fmt.int(h.domains.length) : '-',
      sub: checks.domains.status === 'ok' ? '' : checkSub(checks.domains, 'none verified') },
    { label: 'Script present', value: scriptReady ? sitesValue : '-', cls: scriptReady ? sitesCls : '',
      sub: scriptReady ? sitesSub : checkSub(checks.script, 'no result') },
    { label: 'Ads missing tracking params', value: paramsReady ? fmt.int(flagged.length) : '-', cls: paramsReady ? (flagged.length ? 'bad' : 'good') : '',
      sub: paramsReady ? channelsSub(checks.params, h.trackingParams.map((p) => p.type).join(', '))
        : (!hasGoogle ? 'no Google ad accounts' : checkSub(checks.params, `${channelsSub(checks.params, 'checked')}: no ads in the last hour`)) },
    { label: 'Check errors', value: fmt.int(errors.length), cls: errors.length ? 'bad' : '', sub: errors.length ? shortReason(errors[0]) : (running ? 'checks still running' : 'none') },
  ]);

  const scriptStatus = checks.script.status !== 'ok' ? statusLine(checks.script) : null;
  let scriptBody;
  if (groups.length && (scripts.length || checks.script.status === 'pending')) scriptBody = groups.map((g) => siteRow(g, esc)).join('');
  else if (!scriptStatus) scriptBody = `<div class="empty">${esc(h.domains.length ? 'No script check result.' : SKIP_LINE['no verified domains'])}</div>`;
  else scriptBody = '';
  const unchecked = Array.isArray(checks.script.unchecked) && checks.script.unchecked.length && checks.script.status !== 'pending'
    ? `<div class="sub health-unchecked">Not checked: ${esc(checks.script.unchecked.join(', '))}</div>` : '';

  let paramsBody;
  if (paramRows.length) {
    // The panel lists the flagged rows first and stops at MAX_PARAM_ROWS; the tile above counts every row.
    const listed = [...flagged, ...paramRows.filter((r) => !isFlagged(r))].slice(0, MAX_PARAM_ROWS);
    const more = paramRows.length - listed.length;
    paramsBody = listed.map((r) => {
      const bad = isFlagged(r);
      const label = [r.campaignName, r.adGroupName].filter(Boolean).join(' / ') || r.adName || r.name || String(r.adGroupId || r.campaignId || r.id || '');
      const link = r.trackingUrlTemplate || r.finalUrlSuffix || '';
      return `<div class="health-row"><span class="pill">${esc(r._type)}</span><code title="${esc(link)}">${esc(label)}</code>
        ${r.customerId ? `<span class="sub">${esc(r.customerId)}</span>` : ''}
        <span class="pill ${bad ? 'bad' : 'ok'}">${bad ? 'missing / invalid' : 'ok'}</span></div>`;
    }).join('') + (more > 0 ? `<div class="sub">${esc(fmt.int(more))} more ads not listed (${esc(fmt.int(paramRows.length))} checked, missing ones first)</div>` : '');
  } else if (!hasGoogle) {
    paramsBody = `<div class="empty">${esc(SKIP_LINE['no Google ad accounts connected'])}</div>`;
  } else if (statusLine(checks.params)) {
    paramsBody = statusRow(checks.params, esc, statusLine(checks.params));
  } else {
    paramsBody = `<div class="empty">${esc(checks.params.status === 'empty' ? 'No ads reported by the check in the last hour.' : 'No check result.')}</div>`;
  }

  const acct = account || {};
  const access = `<div class="fpanel"><h3>Account &amp; access</h3>
      <div class="fhint">connected ad accounts and agency relationships</div>
      ${adAccounts.map((a) => `<div class="health-row"><code>${esc(a.name || a.id)}</code><span class="pill">${esc(a.type)}</span><span class="sub">${esc(a.id)}</span></div>`).join('') || '<div class="empty">No ad accounts connected.</div>'}
      ${(acct.managedBy || []).map((a) => `<div class="health-row"><code>managed by ${esc(a.email || a.company || a.accountId || '-')}</code><span class="pill ${a.status === 'APPROVED' ? 'ok' : ''}">${esc(a.status || '')}</span></div>`).join('')}
      ${(acct.clients || []).map((a) => `<div class="health-row"><code>client ${esc(a.email || a.company || a.accountId || '-')}</code><span class="pill ${a.status === 'APPROVED' ? 'ok' : ''}">${esc(a.status || '')}</span></div>`).join('')}
      ${acct.attributionWindowDefault ? `<div class="health-row"><code>account attribution window</code><span class="pill">${esc(fmt.int(acct.attributionWindowDefault))} days</span></div>` : ''}
    </div>`;

  return `
    <div class="note"><b>Tracking Health.</b> Is the HYROS script actually on your sites, and do your ad
      links carry the parameters attribution needs? Checked by HYROS itself
      (<code>hyros_assert_script_presence_on_domain</code>, <code>hyros_check_tracking_parameters_for_integrations</code>).
      ${running ? ' <span class="pill">checks running</span>' : ''}</div>
    ${tiles}
    ${errors.length ? `<div class="fcols">${checksPanel(h, fmt, esc)}${errorsPanel(errors, esc)}</div>` : checksPanel(h, fmt, esc)}
    <div class="fcols">
      <div class="fpanel"><h3>Script presence</h3>
        <div class="fhint">the universal script, fetched and inspected on the site behind each verified tracking domain (apex and www, 3 URLs per call, the MCP's limit). The check reads the raw page, so a script your site builder injects can read "not found": a site where HYROS recorded visits in the last 7 days counts as tracked</div>
        ${scriptStatus ? statusRow(checks.script, esc, scriptStatus) : ''}
        ${scriptBody}
        ${unchecked}
      </div>
      ${access}
    </div>
    <div class="fpanel"><h3>Ad link tracking parameters</h3>
      <div class="fhint">per ad group (or campaign for Performance Max), whether the parameters HYROS needs are present and well-formed (Google integrations seen in the last hour)</div>
      ${paramsBody}
    </div>`;
}

export const view = {
  id: 'health',
  title: 'Health',
  version: '0.1.0',
  description: 'Is tracking working: the HYROS script on each site behind the verified domains, and the tracking parameters on Google ad links.',
  style: true,
  tools: ['hyros_get_user_info', 'hyros_get_ad_accounts', 'hyros_get_domains', 'hyros_check_tracking_parameters_for_integrations',
    'hyros_assert_script_presence_on_domain', 'hyros_get_leads', 'hyros_get_lead_clicks'],
  author: 'HYROS',

  async render(ctx) {
    const seq = ++renderSeq;
    const isCurrent = () => seq === renderSeq;
    const deadline = Date.now() + VIEW_LOAD_MS - DEADLINE_MARGIN_MS;
    const { root, data, esc } = ctx;

    const account = await data.account();
    const adAccounts = (await data.adAccounts()).rows;
    if (!isCurrent()) return;
    const today = ymdInTz(data.now(), account?.timezone);
    const hasGoogle = hasGoogleAccount(adAccounts);

    const paint = (h) => { if (isCurrent()) root.innerHTML = html(ctx, h, { adAccounts, account }); };

    // Resolve once the cheap checks (domains, params) are painted; script and visits fill in afterwards.
    let ready;
    const firstPaint = new Promise((resolve) => { ready = resolve; });
    const onUpdate = (h) => {
      paint(h);
      if (h.checks.domains.status !== PENDING.status && h.checks.params.status !== PENDING.status) ready();
    };
    runChecks(data, { hasGoogle, today, deadline, isCurrent, onUpdate })
      .catch((err) => {
        if (isCurrent()) root.insertAdjacentHTML('afterbegin', `<div class="note err">${esc(err?.message || 'The checks could not run.')}</div>`);
      })
      .finally(() => ready());
    await firstPaint;
  },
};

