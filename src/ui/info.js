/**
 * The info bubble: a small round "i" beside a label, and the sentence that
 * explains the label in a bubble under it. Use it for a note the reader needs
 * once and not on every look, so the screen keeps its figures and loses the
 * paragraph.
 *
 * A view writes the button with `infoButton(text)` and nothing else: the shell
 * calls `watchInfo()` once and one bubble serves every button. It opens on
 * hover and on keyboard focus, a click or a tap keeps it open, and Escape, a
 * press anywhere else or a second click closes it.
 */
import { esc } from './dom.js';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6"/><path d="M8 7.3v4"/><circle class="info-dot" cx="8" cy="4.75" r=".6"/></svg>';

/** The button. `text` is the sentence the bubble shows, `label` what a screen reader calls the button. */
export function infoButton(text, label = 'About these numbers') {
  return `<button type="button" class="info-btn" data-info="${esc(text)}" aria-label="${esc(label)}" aria-expanded="false">${ICON}</button>`;
}

/**
 * Where the bubble goes, in window pixels. It sits under the button, centered
 * on it, and never leaves the window: it slides sideways at an edge, and goes
 * above the button when there is no room under it. `caret` is where the
 * pointer sits along the bubble, so it stays on the button.
 */
export function placeBubble({ anchor, size, view, gap = 9, pad = 10 }) {
  const mid = anchor.left + anchor.width / 2;
  const left = clamp(mid - size.width / 2, pad, Math.max(pad, view.width - pad - size.width));
  const under = anchor.bottom + gap;
  const over = anchor.top - gap - size.height;
  const up = under + size.height > view.height - pad && over >= pad;
  return { left, top: up ? over : under, up, caret: clamp(mid - left, 16, Math.max(16, size.width - 16)) };
}

/** One bubble for every `.info-btn` under `root`, now and as views render. */
export function watchInfo(root = document) {
  const pop = document.createElement('div');
  pop.className = 'info-pop';
  pop.id = 'infoPop';
  pop.setAttribute('role', 'tooltip');
  pop.hidden = true;
  document.body.append(pop);

  let owner = null;
  let pinned = false;
  // a view can repaint under an open bubble: it closes with its button
  const gone = new MutationObserver(() => { if (owner && !owner.isConnected) close(); });

  const place = () => {
    if (!owner) return;
    const box = owner.getBoundingClientRect();
    const at = placeBubble({
      anchor: { left: box.left, top: box.top, bottom: box.bottom, width: box.width },
      size: { width: pop.offsetWidth, height: pop.offsetHeight },
      view: { width: document.documentElement.clientWidth, height: window.innerHeight },
    });
    pop.style.left = `${Math.round(at.left)}px`;
    pop.style.top = `${Math.round(at.top)}px`;
    pop.style.setProperty('--caret', `${Math.round(at.caret)}px`);
    pop.classList.toggle('is-up', at.up);
  };

  function open(btn, pin) {
    if (owner && owner !== btn) close();
    owner = btn;
    pinned = pin;
    pop.textContent = btn.dataset.info || '';
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-describedby', pop.id);
    place();
    gone.observe(document.body, { childList: true, subtree: true });
  }

  function close() {
    if (!owner) return;
    owner.setAttribute('aria-expanded', 'false');
    owner.removeAttribute('aria-describedby');
    owner = null;
    pinned = false;
    pop.hidden = true;
    gone.disconnect();
  }

  const button = (event) => event.target instanceof Element ? event.target.closest('.info-btn') : null;

  root.addEventListener('pointerover', (event) => {
    const btn = button(event);
    if (btn && event.pointerType === 'mouse' && !(pinned && owner === btn)) open(btn, false);
  });
  root.addEventListener('pointerout', (event) => {
    const btn = button(event);
    if (btn && btn === owner && !pinned && !btn.contains(event.relatedTarget)) close();
  });
  root.addEventListener('focusin', (event) => {
    const btn = button(event);
    if (btn && owner !== btn) open(btn, false);
  });
  root.addEventListener('focusout', (event) => {
    if (button(event) === owner && !pinned) close();
  });
  root.addEventListener('click', (event) => {
    const btn = button(event);
    if (!btn) return;
    if (owner === btn && pinned) close();
    else open(btn, true);
  });
  root.addEventListener('pointerdown', (event) => {
    if (owner && !button(event) && !pop.contains(event.target)) close();
  }, true);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && owner) close();
  });
  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place);
}
