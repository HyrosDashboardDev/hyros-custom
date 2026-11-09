/**
 * The shell: wires auth, the API client and the data API, decides between the
 * sign-in card, the connecting/failed gate and the app, and runs the tabs
 * listed in views/registry.js. When the token's account can read other
 * accounts (an agency and its clients), the account email becomes a switcher
 * that swaps the data API for one bound to the chosen account.
 */
import { createAuth, createHostProvider, createOAuthProvider } from './core/auth.js';
import * as api from './core/api.js';
import { directUrls, resolveApiUrl, resolveAuthServer, resolveEnv, resolveFallback, resolveMcpUrl, resolveRedirectUri } from './core/config.js';
import { createRoutes } from './core/routes.js';
import { createThemeReceiver } from './core/theme.js';
import { VIEW_LOAD_MS } from './core/budget.js';
import { createData } from './data/data.js';
import { $, esc, card, kpis } from './ui/dom.js';
import { fmt } from './ui/fmt.js';
import { VIEWS } from './views/registry.js';

const COPY = {
  NO_TOKEN: 'HYROS did not hand over the dashboard credential.',
  auth: 'HYROS rejected the dashboard credential. Reload this page from HYROS.',
  forbidden: 'This HYROS login cannot read this data. Ask the account owner for access.',
  rate_limited: 'HYROS is rate limiting this account. Wait a minute and press Refresh.',
  timeout: 'HYROS took too long to answer. Press Refresh again.',
  network: 'Could not reach HYROS. If you use an ad blocker or antivirus, allow hyros.com and reload.',
};
const SIGN_IN_TEXT = 'Sign in with your HYROS account to see this dashboard. It can only read your data.';
const REFUSAL_NEXT = 'Contact the account owner or HYROS support, then reload this page.';

/** What to tell the user about a failed call. `not_allowed` and unknown errors show their own message. */
function failureCopy(err) {
  const retryAfterMs = err?.detail?.retryAfterMs;
  if (err?.code === 'rate_limited' && retryAfterMs > 0) {
    return `HYROS is rate limiting this account. Wait ${Math.ceil(retryAfterMs / 1000)} s and press Refresh.`;
  }
  if (err?.code && COPY[err.code]) return COPY[err.code];
  return err?.message || 'Something went wrong talking to HYROS.';
}

/** Null inside HYROS. */
let oauth = null;
let auth;
let data;
/** id -> Promise<view>, imported once per page load. */
const modules = new Map();
/** Ids of views whose style.css is already linked in <head>. */
const linkedStyles = new Set();
let active = null;
/** Bumped on every render so a slow render never repaints the header state of a newer one. */
let generation = 0;
/** The token's own account, as first read: its client accounts are what the switcher lists. */
let home = null;
/** Bumped on every account switch so a slower switch never lands after a newer one. */
let switching = 0;

function showGate({ title, text = '', retry = false, signIn = false }) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#gateTitle').textContent = title;
  $('#gateText').textContent = text;
  $('#gateText').hidden = !text;
  $('#gateRetry').hidden = !retry;
  $('#gateSignIn').hidden = !signIn;
}

const needsSignIn = (err) => Boolean(oauth) && (err?.code === 'SIGN_IN' || err?.code === 'auth');

function showSignIn(err) {
  const text = err?.code === 'SIGN_IN' && err.message ? err.message : SIGN_IN_TEXT;
  showGate({ title: 'Sign in with HYROS', text, signIn: true });
}

/** No button: signing in again or retrying cannot fix what HYROS refused. */
function showRefusal(err) {
  showGate({ title: 'HYROS refused this dashboard', text: `${err.refusal} ${REFUSAL_NEXT}` });
}

async function signIn() {
  showGate({ title: 'Signing in with HYROS…' });
  try {
    await oauth.signIn();
  } catch (err) {
    showGate({ title: 'Could not start the HYROS sign-in', text: err?.message || 'Something went wrong talking to HYROS.', signIn: true });
  }
}

function setBusy(busy) {
  $('#refreshBtn').disabled = busy;
}

/** Link a view's own stylesheet once, for views that declare `style: true`. */
function linkViewStyle(id, view) {
  if (view?.style !== true || linkedStyles.has(id)) return;
  linkedStyles.add(id);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `./src/views/${id}/style.css`;
  document.head.append(link);
}

function loadView(id) {
  if (!modules.has(id)) {
    modules.set(id, import(`./views/${id}/view.js`).then((m) => {
      linkViewStyle(id, m.view);
      return m.view;
    }));
  }
  return modules.get(id);
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('This view took too long to load. Press Retry.')), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function show(id) {
  active = id;
  const gen = ++generation;
  for (const tab of document.querySelectorAll('#tabs .tab')) tab.classList.toggle('active', tab.dataset.id === id);

  // A fresh root per render: a render that finishes after the user moved on writes into a detached node.
  const root = document.createElement('div');
  root.className = 'view';
  root.innerHTML = '<div class="empty"><img class="sven-load" src="./assets/brand/sven-lavender.svg" alt="">Loading…</div>';
  $('#view').replaceChildren(root);
  setBusy(true);

  try {
    const view = await loadView(id);
    await withTimeout(Promise.resolve(view.render({ root, data, fmt, esc, kpis, now: data.now })), VIEW_LOAD_MS);
  } catch (err) {
    if (err?.refusal) {
      showRefusal(err);
      return;
    }
    if (needsSignIn(err)) {
      showSignIn(err);
      return;
    }
    root.innerHTML = `${card({ title: 'This view could not load.', body: esc(failureCopy(err)), kind: 'err' })}
      <button type="button" data-retry>Retry</button>`;
    root.querySelector('[data-retry]').addEventListener('click', () => show(id));
  } finally {
    if (gen === generation) setBusy(false);
  }
}

/** Money and dates follow the account being read. */
function applyAccount(account) {
  fmt.currency = fmt.currencyCode(account.currency);
  fmt.timezone = account.timezone;
}

/** The client accounts the switcher lists: the APPROVED ones, the only ones HYROS lets the token read. */
function switchable(account) {
  return (account?.clients || []).filter((c) => c.accountId && c.status === 'APPROVED');
}

/** The email of the account being read, or a switcher between the token's own account and its clients. */
function renderAccountLabel(account) {
  const label = $('#acctLabel');
  const clients = switchable(home);
  if (!clients.length) {
    label.textContent = account.email || '';
    return;
  }
  const current = data.accountId || '';
  const options = [
    { id: '', text: home.email || 'My account', title: 'Your account' },
    ...clients.map((c) => ({ id: c.accountId, text: c.email || c.company || c.accountId, title: c.company || '' })),
  ];
  label.innerHTML = `<select id="acctSwitch" aria-label="Account to show">${options.map((o) => `
    <option value="${esc(o.id)}" title="${esc(o.title)}"${o.id === current ? ' selected' : ''}>${esc(o.text)}</option>`).join('')}</select>`;
}

/** Views that keep state between renders (filters, drill paths) drop it: it belonged to the other account. */
async function resetViews() {
  await Promise.all([...modules.values()].map((loading) => loading.then((view) => {
    try { view?.reset?.(); } catch { /* a view that fails to reset still renders */ }
  }, () => {})));
}

/** Read `accountId` (null for the token's own account) from now on: a new data API, the same tab. */
async function switchAccount(accountId) {
  const seq = ++switching;
  const next = createData({ api, accountId });
  const select = $('#acctSwitch');
  if (select) select.disabled = true;
  try {
    const account = await next.account();
    if (seq !== switching) return;
    data = next;
    applyAccount(account);
    await resetViews();
    if (select) select.disabled = false;
    await show(active);
  } catch (err) {
    if (seq !== switching) return;
    if (select) {
      select.disabled = false;
      select.value = data.accountId || '';
    }
    if (err?.refusal) {
      showRefusal(err);
      return;
    }
    if (needsSignIn(err)) {
      showSignIn(err);
      return;
    }
    // A 403 here is HYROS saying this login may not read that account (not approved, or not active): its own words say which.
    const text = err?.code === 'forbidden' && err.detail ? err.detail : failureCopy(err);
    const root = document.createElement('div');
    root.className = 'view';
    root.innerHTML = `${card({ title: 'Could not switch to that account.', body: esc(text), kind: 'err' })}
      <button type="button" data-retry>Back</button>`;
    root.querySelector('[data-retry]').addEventListener('click', () => show(active));
    $('#view').replaceChildren(root);
  }
}

async function enterApp(account) {
  if (!data.accountId) home = account;
  applyAccount(account);
  renderAccountLabel(account);

  const views = await Promise.all(VIEWS.map((id) => loadView(id).catch(() => null)));
  $('#tabs').innerHTML = VIEWS.map((id, i) => {
    const title = typeof views[i]?.title === 'string' ? views[i].title : id;
    return `<button type="button" class="tab" data-id="${esc(id)}">${esc(title)}</button>`;
  }).join('');

  $('#gate').hidden = true;
  $('#app').hidden = false;
  await show(active && VIEWS.includes(active) ? active : VIEWS[0]);
}

async function connect(reason) {
  showGate({ title: 'Connecting to HYROS…' });
  try {
    if (reason) await auth.getToken(reason);
    const account = await data.account();
    await enterApp(account);
  } catch (err) {
    if (err?.refusal) {
      showRefusal(err);
      return;
    }
    if (needsSignIn(err)) {
      showSignIn(err);
      return;
    }
    showGate({ title: 'Could not connect to HYROS', text: failureCopy(err), retry: true });
  }
}

function refresh() {
  if (!active) return;
  data.invalidate();
  show(active);
}

/** The theme switch exists only at the dashboard's own url: inside HYROS the theme is HYROS's. */
function wireThemeSwitch(theme) {
  if (theme.isEmbedded()) return;
  const buttons = document.querySelectorAll('.theme-toggle');
  const label = () => (theme.current() === 'dark' ? 'Switch to the white theme' : 'Switch to the dark theme');
  for (const button of buttons) {
    button.hidden = false;
    button.title = label();
    button.setAttribute('aria-label', label());
    button.addEventListener('click', () => {
      theme.toggle();
      for (const other of buttons) {
        other.title = label();
        other.setAttribute('aria-label', label());
      }
    });
  }
}

function boot() {
  // Before the first request for a token: HYROS answers `ready` with the theme first.
  wireThemeSwitch(createThemeReceiver());
  const mcpUrl = resolveMcpUrl();
  const apiUrl = resolveApiUrl(mcpUrl);
  // A known environment starts on its direct hosts and falls back to the hosts of the build's fallback
  // metas, when the build has them, if a call gets no answer at all (resolveFallback). An unknown one
  // (a local server) uses the configured urls only.
  const env = resolveEnv(mcpUrl, apiUrl);
  const direct = env ? directUrls(env) : null;
  const routes = direct ? createRoutes({ direct, fallbacks: resolveFallback() }) : null;
  const host = createHostProvider();
  if (!host.isAvailable()) {
    host.dispose();
    oauth = createOAuthProvider({ authServer: direct ? direct.auth : resolveAuthServer(mcpUrl), routes, redirectUri: resolveRedirectUri() });
  }
  auth = createAuth({ provider: oauth || host });
  const apiBase = direct ? direct.api : apiUrl;
  if (!apiBase) {
    // build.mjs refuses this; only a page served without the build gets here.
    showGate({ title: 'This dashboard is not set up', text: `There is no HYROS API for ${mcpUrl}. Build it with HYROS_API_URL.` });
    return;
  }
  api.configure({ url: apiBase, routes, getToken: auth.getToken, markInvalid: auth.markInvalid });
  data = createData({ api });

  $('#gateRetry').addEventListener('click', () => connect('retry'));
  $('#gateSignIn').addEventListener('click', signIn);
  $('#refreshBtn').addEventListener('click', refresh);
  $('#acctLabel').addEventListener('change', (event) => {
    if (event.target.id === 'acctSwitch') switchAccount(event.target.value || null);
  });
  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab && tab.dataset.id !== active) show(tab.dataset.id);
  });

  // Back from the HYROS sign-in page, the browser may restore this page as it was left: "Signing in…".
  window.addEventListener('pageshow', (event) => {
    if (oauth && event.persisted && !$('#gate').hidden) showSignIn();
  });

  // Redirect straight to the sign-in, unless the user just came back from it without finishing.
  if (oauth && !oauth.hasCallback()) {
    if (oauth.wasAbandoned()) showSignIn();
    else signIn();
    return;
  }
  connect();
}

boot();
