/**
 * The HYROS theme. Inside HYROS (an iframe) the host posts the theme its user
 * has, before the token, and again whenever the user switches it:
 *
 *   host -> dashboard   { type: 'theme', version: 2, theme: 'dark' | 'white' }
 *   dashboard -> host   { type: 'theme-applied', version: 2, theme }
 *
 * The theme lands on <html data-theme>, and the tokens in styles.css follow
 * it. index.html marks <html data-theme-pending> when the page runs in a
 * frame, which keeps it invisible; the first theme, or the fallback after
 * THEME_TIMEOUT_MS, removes the mark.
 *
 * At its own url there is no host: the page is white unless the user picked
 * dark with the theme switch, which is kept in localStorage under
 * THEME_STORAGE_KEY. index.html applies a saved dark before the first paint.
 * Inside HYROS the switch does nothing and storage is never read: HYROS
 * decides.
 */
import { CONFIG } from './config.js';
import { PROTOCOL_VERSION } from './auth.js';

export const THEMES = Object.freeze(['dark', 'white']);
export const DEFAULT_THEME = 'white';
/** How long an embedded page waits for the theme before it shows itself in the default one. */
export const THEME_TIMEOUT_MS = 1500;
/** Where the page at its own url keeps the theme picked with the switch. index.html reads the same key. */
export const THEME_STORAGE_KEY = 'hyros-dashboard-theme';

/** localStorage, or null where reading it throws (Safari with storage blocked). */
function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 *   current()     the theme on the page now
 *   isEmbedded()  whether HYROS decides the theme (the page runs in a frame)
 *   toggle()      at its own url, switches between dark and white and keeps
 *                 the choice; inside HYROS it does nothing. Returns the theme.
 *   dispose()     stops listening
 *
 * A theme from HYROS is accepted only from the parent window, from an allowed
 * origin, at the current protocol version and with a known value. Each one is
 * confirmed to that same origin with `theme-applied`, so HYROS knows the page
 * has painted in it.
 */
export function createThemeReceiver({
  win = globalThis.window,
  doc = globalThis.document,
  storage = browserStorage(),
  origins = CONFIG.hostOrigins,
  timeoutMs = THEME_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const root = doc?.documentElement;
  const embedded = Boolean(win) && win.parent != null && win.parent !== win;
  let theme = DEFAULT_THEME;
  let timer = null;

  /**
   * Sets the theme with transitions off (data-theme-switching), so every
   * color changes in the same frame. Reading a computed style makes the
   * browser apply the new colors before the mark goes away; without that the
   * transitions would still run.
   */
  function apply(next) {
    theme = next;
    root?.setAttribute('data-theme-switching', '');
    root?.setAttribute('data-theme', next);
    if (root && typeof win?.getComputedStyle === 'function') win.getComputedStyle(root).getPropertyValue('color');
    root?.removeAttribute('data-theme-switching');
    reveal();
  }

  function reveal() {
    root?.removeAttribute('data-theme-pending');
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function saved() {
    try {
      const value = storage?.getItem(THEME_STORAGE_KEY);
      return THEMES.includes(value) ? value : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  }

  function onMessage(event) {
    if (event.source !== win.parent || !origins.includes(event.origin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'theme' || data.version !== PROTOCOL_VERSION || !THEMES.includes(data.theme)) return;
    apply(data.theme);
    try {
      win.parent.postMessage({ type: 'theme-applied', version: PROTOCOL_VERSION, theme: data.theme }, event.origin);
    } catch { /* the parent went away: nothing to confirm to */ }
  }

  if (embedded) {
    root?.setAttribute('data-theme', theme);
    win.addEventListener('message', onMessage);
    timer = setTimer(() => {
      timer = null;
      reveal();
    }, timeoutMs);
  } else {
    apply(saved());
  }

  function toggle() {
    if (embedded) return theme;
    apply(theme === 'dark' ? 'white' : 'dark');
    try {
      storage?.setItem(THEME_STORAGE_KEY, theme);
    } catch { /* storage blocked: the switch still works until the page closes */ }
    return theme;
  }

  function dispose() {
    if (embedded) win.removeEventListener('message', onMessage);
    reveal();
  }

  return { current: () => theme, isEmbedded: () => embedded, toggle, dispose };
}
