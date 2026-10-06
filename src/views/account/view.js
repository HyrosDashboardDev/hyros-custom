/**
 * Account: who this dashboard is looking at. The worked example of a view
 * (VIEWS.md); src/views/_template/ is the skeleton to copy for a new one.
 *
 * ctx = { root, data, fmt, esc, kpis, now }
 */
export const view = {
  id: 'account',
  title: 'Account',
  version: '0.1.0',
  description: 'The account the dashboard is looking at: owner, timezone, currency, attribution window, sources and ad accounts.',
  style: false,
  tools: ['hyros_get_user_info', 'hyros_get_ad_accounts', 'hyros_get_sources'],
  author: 'HYROS',

  async render(ctx) {
    const { root, data, fmt, esc, kpis } = ctx;
    const [account, adAccounts, sources] = await Promise.all([data.account(), data.adAccounts(), data.sources()]);

    const attributionDays = account.attributionWindowDefault;
    const tiles = kpis([
      { label: 'Email', value: account.email || '-' },
      { label: 'Timezone', value: account.timezone || '-' },
      { label: 'Currency', value: fmt.currencyCode(account.currency) },
      { label: 'Attribution window', value: attributionDays ? `${fmt.int(attributionDays)} days` : '-', sub: 'account default' },
      { label: 'Sources', value: fmt.int(sources.rows.length), sub: sources.truncated ? 'more exist, list cut short' : '' },
    ]);

    const rows = adAccounts.rows.map((a) => `
      <tr>
        <td class="txt">${esc(a.id)}</td>
        <td class="txt">${esc(a.name)}</td>
        <td class="txt"><span class="pill">${esc(a.type)}</span></td>
      </tr>`).join('');

    const table = adAccounts.rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th class="txt">ID</th><th class="txt">Name</th><th class="txt">Type</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : '<div class="empty">No ad accounts connected</div>';

    root.innerHTML = `
      ${tiles}
      <h2 class="section">Ad accounts <span class="rowcount">${fmt.int(adAccounts.rows.length)}${adAccounts.truncated ? ', list cut short' : ''}</span></h2>
      ${table}`;
  },
};
