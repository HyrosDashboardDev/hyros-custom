/**
 * The shell: wires auth, the MCP client and the data API, decides between the
 * "open from HYROS" card, the connecting/failed gate and the app, and runs the
 * tabs listed in views/registry.js.
 */
import { createAuth, createHostProvider } from './core/auth.js';
import * as mcp from './core/mcp.js';
import { resolveMcpUrl } from './core/config.js';
import { VIEW_LOAD_MS } from './core/budget.js';
import { createData } from './data/data.js';
import { $, esc, card, kpis } from './ui/dom.js';
import { fmt } from './ui/fmt.js';
import { VIEWS } from './views/registry.js';

const COPY = {
  NO_TOKEN: 'HYROS did not hand over the dashboard credential.',
  auth: 'HYROS rejected the dashboard credential. Reload this page from HYROS.',
  forbidden: 'This account cannot use the MCP. Ask HYROS support to enable it.',
  rate_limited: 'HYROS is rate limiting this account. Wait a minute and press Refresh.',
  timeout: 'HYROS took too long to answer. Press Refresh again.',
};

/** What to tell the user about a failed call. `not_allowed` and unknown errors show their own message. */
function failureCopy(err) {
  if (err?.code && COPY[err.code]) return COPY[err.code];
  return err?.message || 'Something went wrong talking to HYROS.';
}

let auth;
let data;
/** id -> Promise<view>, imported once per page load. */
const modules = new Map();
/** Ids of views whose style.css is already linked in <head>. */
const linkedStyles = new Set();
let active = null;
/** Bumped on every render so a slow render never repaints the header state of a newer one. */
let generation = 0;

function showGate({ title, text = '', retry = false }) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#gateTitle').textContent = title;
  $('#gateText').textContent = text;
  $('#gateText').hidden = !text;
  $('#gateRetry').hidden = !retry;
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
    root.innerHTML = `${card({ title: 'This view could not load.', body: esc(failureCopy(err)), kind: 'err' })}
      <button type="button" data-retry>Retry</button>`;
    root.querySelector('[data-retry]').addEventListener('click', () => show(id));
  } finally {
    if (gen === generation) setBusy(false);
  }
}

async function enterApp(account) {
  fmt.currency = fmt.currencyCode(account.currency);
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
    showGate({ title: 'Could not connect to HYROS', text: failureCopy(err), retry: true });
  }
}

function refresh() {
  if (!active) return;
  data.invalidate();
  show(active);
}

function boot() {
  auth = createAuth({ provider: createHostProvider() });
  mcp.configure({ url: resolveMcpUrl(), getToken: auth.getToken, markInvalid: auth.markInvalid });
  data = createData({ mcp });

  if (!auth.isEmbedded()) {
    showGate({ title: 'Open this dashboard from HYROS', text: 'Open this dashboard from HYROS to see your account.' });
    return;
  }

  $('#gateRetry').addEventListener('click', () => connect('retry'));
  $('#refreshBtn').addEventListener('click', refresh);
  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab && tab.dataset.id !== active) show(tab.dataset.id);
  });
  connect();
}

boot();
