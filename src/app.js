/**
 * The shell: wires auth, the API client and the data API, decides between the
 * sign-in card, the connecting/failed gate and the app, and runs the tabs
 * listed in views/registry.js.
 */
import { createAuth, createHostProvider, createOAuthProvider } from './core/auth.js';
import * as api from './core/api.js';
import { resolveApiUrl, resolveAuthServer, resolveMcpUrl, resolveRedirectUri } from './core/config.js';
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

async function enterApp(account) {
  fmt.currency = fmt.currencyCode(account.currency);
  fmt.timezone = account.timezone;
  $('#acctLabel').textContent = account.email || '';

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
  const host = createHostProvider();
  if (!host.isAvailable()) {
    host.dispose();
    oauth = createOAuthProvider({ authServer: resolveAuthServer(mcpUrl), redirectUri: resolveRedirectUri() });
  }
  auth = createAuth({ provider: oauth || host });
  const apiUrl = resolveApiUrl(mcpUrl);
  if (!apiUrl) {
    // build.mjs refuses this; only a page served without the build gets here.
    showGate({ title: 'This dashboard is not set up', text: `There is no HYROS API for ${mcpUrl}. Build it with HYROS_API_URL.` });
    return;
  }
  api.configure({ url: apiUrl, getToken: auth.getToken, markInvalid: auth.markInvalid });
  data = createData({ api });

  $('#gateRetry').addEventListener('click', () => connect('retry'));
  $('#gateSignIn').addEventListener('click', signIn);
  $('#refreshBtn').addEventListener('click', refresh);
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
