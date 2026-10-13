import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThemeReceiver, DEFAULT_THEME, THEME_STORAGE_KEY, THEME_TIMEOUT_MS } from '../src/core/theme.js';

const HOST = 'http://localhost:4323';
const ORIGINS = ['https://app.hyros.com', HOST];

/** Timers that only fire when the test advances them. */
function fakeTimers() {
  const timers = new Map();
  let seq = 0;
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    fireAll() {
      const due = [...timers.values()];
      timers.clear();
      for (const { fn } of due) fn();
    },
  };
}

/** <html>: only the attributes the receiver touches. */
function fakeDoc({ pending = false } = {}) {
  const attrs = new Map(pending ? [['data-theme-pending', '']] : []);
  return {
    documentElement: {
      setAttribute: (name, value) => attrs.set(name, String(value)),
      removeAttribute: (name) => attrs.delete(name),
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      hasAttribute: (name) => attrs.has(name),
    },
  };
}

/** A window inside a frame: records what it posts to its parent and lets the test deliver messages. */
function fakeWin({ embedded = true } = {}) {
  const listeners = new Set();
  const posted = [];
  const parent = { postMessage: (data, targetOrigin) => posted.push({ data, targetOrigin }) };
  const win = {
    posted,
    listeners,
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    deliver: (event) => { for (const fn of listeners) fn(event); },
  };
  win.parent = embedded ? parent : win;
  return win;
}

/** localStorage: a map, or one that throws like Safari with storage blocked. */
function fakeStorage(entries = {}, { blocked = false } = {}) {
  const map = new Map(Object.entries(entries));
  const guard = () => { if (blocked) throw new Error('SecurityError'); };
  return {
    map,
    reads: 0,
    getItem(key) { guard(); this.reads += 1; return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { guard(); map.set(key, String(value)); },
  };
}

function setup({ embedded = true, storage = fakeStorage() } = {}) {
  const timers = fakeTimers();
  const win = fakeWin({ embedded });
  const doc = fakeDoc({ pending: embedded });
  const receiver = createThemeReceiver({ win, doc, storage, origins: ORIGINS, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const html = doc.documentElement;
  const sendTheme = (data, { origin = HOST, source = win.parent } = {}) => win.deliver({ origin, source, data });
  return { timers, win, html, receiver, sendTheme, storage };
}

test('opened at its own url: the default theme, shown at once, nothing listened to or posted', () => {
  const { timers, win, html, receiver } = setup({ embedded: false });
  assert.equal(html.getAttribute('data-theme'), DEFAULT_THEME);
  assert.equal(html.hasAttribute('data-theme-pending'), false);
  assert.equal(receiver.current(), 'white');
  assert.equal(win.listeners.size, 0);
  assert.equal(timers.pending(), 0);
  assert.deepEqual(win.posted, []);
});

test('embedded: the page stays pending until HYROS posts the theme, then shows in it and confirms', () => {
  const { timers, win, html, receiver, sendTheme } = setup();
  assert.equal(html.hasAttribute('data-theme-pending'), true);

  sendTheme({ type: 'theme', version: 2, theme: 'dark' });
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.equal(html.hasAttribute('data-theme-pending'), false);
  assert.equal(receiver.current(), 'dark');
  assert.equal(timers.pending(), 0, 'the fallback timer is cleared');
  assert.deepEqual(win.posted, [{ data: { type: 'theme-applied', version: 2, theme: 'dark' }, targetOrigin: HOST }]);
});

test('a switch in HYROS repaints the page without a reload', () => {
  const { win, html, sendTheme } = setup();
  sendTheme({ type: 'theme', version: 2, theme: 'dark' });
  sendTheme({ type: 'theme', version: 2, theme: 'white' });
  assert.equal(html.getAttribute('data-theme'), 'white');
  sendTheme({ type: 'theme', version: 2, theme: 'dark' });
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.deepEqual(win.posted.map((p) => p.data.theme), ['dark', 'white', 'dark']);
});

test('themes from an unlisted origin, another window, another version or with an unknown value are ignored', () => {
  const { win, html, sendTheme } = setup();
  sendTheme({ type: 'theme', version: 2, theme: 'dark' }, { origin: 'https://evil.example' });
  sendTheme({ type: 'theme', version: 2, theme: 'dark' }, { source: {} });
  sendTheme({ type: 'theme', version: 1, theme: 'dark' });
  sendTheme({ type: 'theme', version: '2', theme: 'dark' });
  sendTheme({ type: 'theme', version: 2, theme: 'light' });
  sendTheme({ type: 'theme', version: 2 });
  sendTheme({ type: 'token', version: 2, token: 't1' });
  sendTheme('theme');
  assert.equal(html.getAttribute('data-theme'), DEFAULT_THEME);
  assert.equal(html.hasAttribute('data-theme-pending'), true);
  assert.deepEqual(win.posted, []);
});

test('no theme in time: the page shows itself in the default theme, and a late theme still applies', () => {
  const { timers, html, sendTheme } = setup();
  assert.equal(THEME_TIMEOUT_MS, 1500);
  timers.fireAll();
  assert.equal(html.hasAttribute('data-theme-pending'), false);
  assert.equal(html.getAttribute('data-theme'), DEFAULT_THEME);

  sendTheme({ type: 'theme', version: 2, theme: 'dark' });
  assert.equal(html.getAttribute('data-theme'), 'dark');
});

test('dispose stops listening and never leaves the page invisible', () => {
  const { timers, win, html, receiver, sendTheme } = setup();
  receiver.dispose();
  assert.equal(win.listeners.size, 0);
  assert.equal(timers.pending(), 0);
  assert.equal(html.hasAttribute('data-theme-pending'), false);
  sendTheme({ type: 'theme', version: 2, theme: 'dark' });
  assert.equal(html.getAttribute('data-theme'), DEFAULT_THEME);
});

test('a parent that throws on postMessage does not break the theme', () => {
  const { win, html, sendTheme } = setup();
  win.parent.postMessage = () => { throw new Error('gone'); };
  sendTheme({ type: 'theme', version: 2, theme: 'dark' });
  assert.equal(html.getAttribute('data-theme'), 'dark');
});

test('at its own url the switch toggles dark and white and keeps the choice', () => {
  const { html, receiver, storage } = setup({ embedded: false });
  assert.equal(receiver.isEmbedded(), false);
  assert.equal(receiver.toggle(), 'dark');
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.equal(storage.map.get(THEME_STORAGE_KEY), 'dark');
  assert.equal(receiver.toggle(), 'white');
  assert.equal(html.getAttribute('data-theme'), 'white');
  assert.equal(storage.map.get(THEME_STORAGE_KEY), 'white');
});

test('at its own url a saved theme applies on load; an unknown saved value is the default', () => {
  assert.equal(setup({ embedded: false, storage: fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }) }).html.getAttribute('data-theme'), 'dark');
  assert.equal(setup({ embedded: false, storage: fakeStorage({ [THEME_STORAGE_KEY]: 'purple' }) }).html.getAttribute('data-theme'), DEFAULT_THEME);
});

test('blocked storage: the default theme on load, and the switch still works for the page', () => {
  const { html, receiver } = setup({ embedded: false, storage: fakeStorage({}, { blocked: true }) });
  assert.equal(html.getAttribute('data-theme'), DEFAULT_THEME);
  assert.equal(receiver.toggle(), 'dark');
  assert.equal(html.getAttribute('data-theme'), 'dark');
});

test('inside HYROS the switch does nothing and storage is never read: HYROS decides', () => {
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' });
  const { html, receiver, sendTheme } = setup({ storage });
  assert.equal(receiver.isEmbedded(), true);
  assert.equal(html.getAttribute('data-theme'), DEFAULT_THEME);
  sendTheme({ type: 'theme', version: 2, theme: 'white' });
  assert.equal(receiver.toggle(), 'white');
  assert.equal(html.getAttribute('data-theme'), 'white');
  assert.equal(storage.reads, 0);
  assert.equal(storage.map.get(THEME_STORAGE_KEY), 'dark');
});

test('a theme change runs with transitions off, and the mark is gone afterwards', () => {
  const { win, html, receiver } = setup({ embedded: false });
  const seen = [];
  win.getComputedStyle = (el) => {
    seen.push({ switching: el.hasAttribute('data-theme-switching'), theme: el.getAttribute('data-theme') });
    return { getPropertyValue: () => '' };
  };
  receiver.toggle();
  assert.deepEqual(seen, [{ switching: true, theme: 'dark' }], 'the new colors are applied while transitions are off');
  assert.equal(html.hasAttribute('data-theme-switching'), false);
});
