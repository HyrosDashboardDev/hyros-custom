# Account: view spec

**id** `account` · **version** 0.1.0 · **tools** `hyros_get_user_info`, `hyros_get_ad_accounts`, `hyros_get_sources`

## Purpose
Who this dashboard is looking at: the account's email, timezone, currency
and default attribution window, how many traffic sources it has, and which
ad accounts are connected. It is the first tab, so it doubles as a check
that the connection works, and it is the worked example of a view.

## Data
Three getters of `ctx.data`, called in parallel. Each is cached for the
life of the page, so other views asking for the same data cost nothing;
Refresh drops the cache (`ctx.data.invalidate()`) and fetches them again.

| Getter | Tool | Request | Paging |
|---|---|---|---|
| `account()` | `hyros_get_user_info` | `{}` | one call |
| `adAccounts()` | `hyros_get_ad_accounts` | `{ request: {} }` | `pageSize: 250`, at most 4 pages |
| `sources()` | `hyros_get_sources` | `{ request: { includeOrganic: true, includeDisregarded: false } }` | `pageSize: 250`, at most 40 pages |

One render costs 3 calls when the cache is cold (more when a list spans
several pages) and none when it is warm. The three tools are different, so
running them in parallel does not collide on the "already processing" rule
(`docs/RECIPES.md` "CRM"); they still share the account's rate limit.

## Rows shape
```json
{
  "account": {
    "email": "owner@example.com",
    "timezone": "-05:00",
    "currency": "USD",
    "attributionWindowDefault": 30,
    "managedBy": [{ "accountId": "", "email": "", "company": "", "status": "" }],
    "clients": [{ "accountId": "", "email": "", "company": "", "status": "" }]
  },
  "adAccounts": { "rows": [{ "id": "123", "name": "Main", "type": "FACEBOOK" }], "truncated": false },
  "sources": { "rows": ["raw hyros_get_sources rows"], "truncated": false }
}
```
`account()` keeps `timezone` raw (`"-05:00"`, `"UTC"`, `"America/New_York"`);
`currency` comes from `trueTrackingData.OUTBOUND_CURRENCY` (default `USD`)
and `attributionWindowDefault` from `trueTrackingData.LEAD_ATTRIBUTION_TIMEFRAME`.
The view uses `email`, `timezone`, `currency` and `attributionWindowDefault`.

## View states
- Data: five KPI tiles (Email, Timezone, Currency, Attribution window,
  Sources) and the "Ad accounts" table (ID, Name, Type as a pill).
- A list cut short: the Sources tile says "more exist, list cut short" and
  the ad accounts count says "list cut short".
- No ad accounts: "No ad accounts connected" (`.empty`).
- A missing account field prints `-`.
- Any of the three calls failing: `render` throws and the shell shows its
  error card with Retry (see Open limitations).

## Rules honoured
- Data only through `ctx.data`; read tools only.
- Every string from HYROS (email, timezone, ad account id, name, type)
  escaped with `ctx.esc`; numbers through `ctx.fmt.int`; the currency code
  through `ctx.fmt.currencyCode`, which falls back to `USD` for anything
  that is not three letters.
- Shared kit only (`.kpis`, `.section`, `.rowcount`, `.table-wrap`,
  `td.txt`, `.pill`, `.empty`); no `style.css`.

## Porting notes
Another dashboard reuses `view.js` unchanged if its `ctx.data` has
`account()`, `adAccounts()` and `sources()` answering the shapes above, and
its `ctx` has `fmt`, `esc` and `kpis`.

## Open limitations
- One failing getter fails the whole tab instead of becoming a warning next
  to the other two.
- The ad accounts list stops at 4 pages of 250, and sources at 40 pages of
  250; past that the view says the list was cut short.
- The agency relationships (`managedBy`, `clients`) are loaded but not
  shown.
