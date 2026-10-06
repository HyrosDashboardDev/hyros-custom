/**
 * The harness side of the postMessage contract, mirroring what HYROS does in
 * customDashboardChannel.ts, plus the parts HYROS does not do yet
 * (token-request, expiresAt). Messages are accepted only from the dashboard
 * origin, from the iframe's own window and at protocol version 1. The token
 * is posted to that exact origin, never to '*'.
 */
const DASHBOARD_ORIGIN = 'http://localhost:4321';
const PROTOCOL_VERSION = 1;

const $ = (id) => document.getElementById(id);
const frame = $('frame');

function load() {
  frame.src = `${DASHBOARD_ORIGIN}/?mcp=${encodeURIComponent($('mcp').value)}`;
  log('loaded', `${DASHBOARD_ORIGIN}/?mcp=${$('mcp').value}`);
}

/** One log line. Never pass the token here. */
function log(type, detail = '') {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()}  ${type}${detail ? `  ${detail}` : ''}`;
  $('log').prepend(item);
}

function tokenMessage() {
  const token = $('token').value.trim();
  if (!token) return null;
  const message = { type: 'token', version: PROTOCOL_VERSION, token };
  if ($('sendExpiry').checked) {
    const minutes = Math.max(1, Number($('expiryMinutes').value) || 15);
    message.expiresAt = Date.now() + minutes * 60_000;
  }
  return message;
}

/** Posts the token if there is one; says whether it did. */
function answer() {
  const message = tokenMessage();
  if (!message || !frame.contentWindow) return false;
  frame.contentWindow.postMessage(message, DASHBOARD_ORIGIN);
  return true;
}

window.addEventListener('message', (event) => {
  if (event.origin !== DASHBOARD_ORIGIN || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.version !== PROTOCOL_VERSION) return;
  if (data.type !== 'ready' && data.type !== 'token-request') return;
  const answered = answer();
  const reason = data.type === 'token-request' ? `reason ${String(data.reason)}` : '';
  const expiry = answered && $('sendExpiry').checked ? `, expiresAt in ${$('expiryMinutes').value} min` : '';
  log(data.type, `${reason}${reason ? '  ' : ''}${answered ? `answered${expiry}` : 'not answered (no token)'}`);
});

$('sendNow').addEventListener('click', () => log('send now', answer() ? 'token posted' : 'no token to send'));
$('reload').addEventListener('click', load);
$('mcp').addEventListener('change', load);
$('clearLog').addEventListener('click', () => $('log').replaceChildren());

load();
