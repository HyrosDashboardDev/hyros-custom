/**
 * The rail: the dashboard's own sideways scrollbar for a table that is wider
 * than its place. It sits in a lane of its own under the table, lined up with
 * the page, and looks the same on every computer; the browser's own sideways
 * bar is switched off for a table that has one. The whole lane is the target:
 * drag the bar, press anywhere on the track, or use the keyboard. The count on
 * the right says how many columns are whole on screen.
 *
 * `watchRails(root)` gives every `.table-wrap` under `root` a rail and keeps
 * doing so as views render: a view writes its table and nothing else.
 */

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** The bar never gets shorter than this share of the track, however wide the table is. */
const MIN_SIZE = 0.06;

/**
 * Where the bar sits, in fractions of the track: its `size`, its `left` edge,
 * how far the table can scroll (`max`) and how far it has (`progress`, 0 to 1).
 * Null when the table fits.
 */
export function railGeometry({ clientWidth, scrollWidth, scrollLeft }) {
  if (!(scrollWidth > clientWidth + 1)) return null;
  const max = scrollWidth - clientWidth;
  const progress = clamp(scrollLeft, 0, max) / max;
  const size = Math.max(clientWidth / scrollWidth, MIN_SIZE);
  return { size, left: progress * (1 - size), max, progress };
}

/** The scroll position that puts the middle of the bar under a point of the track. */
export function scrollForPoint({ x, trackWidth, clientWidth, scrollWidth }) {
  const geo = railGeometry({ clientWidth, scrollWidth, scrollLeft: 0 });
  if (!geo || !(trackWidth > 0)) return 0;
  const bar = geo.size * trackWidth;
  return clamp((x - bar / 2) / (trackWidth - bar), 0, 1) * geo.max;
}

/** How far the table scrolls for one pixel of drag on the bar. */
export function scrollPerPixel({ trackWidth, clientWidth, scrollWidth }) {
  const geo = railGeometry({ clientWidth, scrollWidth, scrollLeft: 0 });
  if (!geo || !(trackWidth > 0)) return 0;
  return geo.max / (trackWidth * (1 - geo.size));
}

/**
 * How many columns are whole on screen. `cols` are the header cells' edges,
 * `view` the table's visible edges. The first column is frozen: it always
 * counts, and the others have to clear it.
 */
export function columnsInView(cols, view) {
  if (!cols.length) return 0;
  const from = Math.max(view.left, cols[0].right) - 1;
  const to = view.right + 1;
  return 1 + cols.slice(1).filter((col) => col.left >= from && col.right <= to).length;
}

const KEY_STEP = 80;
const live = new Set();
let serial = 0;
let queued = false;

const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function mount(wrap) {
  const rail = document.createElement('div');
  rail.className = 'hrail';
  rail.hidden = true;
  const track = document.createElement('div');
  track.className = 'hrail-track';
  if (!wrap.id) wrap.id = `table-${++serial}`;
  for (const [name, value] of Object.entries({ role: 'scrollbar', tabindex: '0', 'aria-orientation': 'horizontal', 'aria-controls': wrap.id, 'aria-label': 'Scroll the table sideways', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' })) track.setAttribute(name, value);
  const thumb = document.createElement('i');
  thumb.className = 'hrail-thumb';
  const note = document.createElement('span');
  note.className = 'hrail-note';
  const count = document.createElement('b');
  const rest = document.createTextNode('');
  note.append(count, rest);
  track.append(thumb);
  rail.append(track, note);
  wrap.after(rail);

  const update = () => {
    const geo = railGeometry(wrap);
    rail.hidden = !geo;
    wrap.classList.toggle('has-rail', Boolean(geo));
    if (!geo) return;
    thumb.style.left = `${geo.left * 100}%`;
    thumb.style.width = `${geo.size * 100}%`;
    track.setAttribute('aria-valuenow', String(Math.round(geo.progress * 100)));
    const box = wrap.getBoundingClientRect();
    const cols = [...wrap.querySelectorAll('thead th')].map((th) => th.getBoundingClientRect());
    count.textContent = String(columnsInView(cols, { left: box.left, right: box.left + wrap.clientWidth }));
    rest.textContent = ` of ${cols.length} columns`;
  };

  const go = (left, smooth) => wrap.scrollTo({ left, behavior: smooth && !calm() ? 'smooth' : 'auto' });

  thumb.addEventListener('pointerdown', (event) => {
    if (event.button) return;
    event.preventDefault();
    event.stopPropagation();
    thumb.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = wrap.scrollLeft;
    const perPixel = scrollPerPixel({ trackWidth: track.clientWidth, clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth });
    rail.classList.add('is-drag');
    const move = (ev) => { wrap.scrollLeft = start + (ev.clientX - startX) * perPixel; };
    const end = () => {
      rail.classList.remove('is-drag');
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', end);
      thumb.removeEventListener('pointercancel', end);
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', end);
    thumb.addEventListener('pointercancel', end);
  });
  track.addEventListener('pointerdown', (event) => {
    if (event.button || event.target === thumb) return;
    const box = track.getBoundingClientRect();
    go(scrollForPoint({ x: event.clientX - box.left, trackWidth: box.width, clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth }), true);
  });
  track.addEventListener('keydown', (event) => {
    const page = wrap.clientWidth * 0.9;
    const to = { ArrowLeft: wrap.scrollLeft - KEY_STEP, ArrowRight: wrap.scrollLeft + KEY_STEP, PageUp: wrap.scrollLeft - page, PageDown: wrap.scrollLeft + page, Home: 0, End: wrap.scrollWidth }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    go(to, false);
  });
  wrap.addEventListener('scroll', schedule, { passive: true });

  const sizes = new ResizeObserver(schedule);
  sizes.observe(wrap);
  // The lane follows the window's bottom edge only while its table is in sight,
  // and wears a hairline while it floats over the rows. It sticks one pixel
  // below the edge, so "not whole on screen" tells a floating lane from a
  // resting one (a root margin would be ignored inside the HYROS frame).
  const near = new IntersectionObserver(([entry]) => rail.classList.toggle('is-near', entry.isIntersecting));
  near.observe(wrap);
  const stuck = new IntersectionObserver(([entry]) => {
    const edge = entry.rootBounds ? entry.rootBounds.bottom : window.innerHeight;
    const box = entry.boundingClientRect;
    rail.classList.toggle('is-stuck', entry.intersectionRatio < 1 && box.top < edge && box.bottom > edge);
  }, { threshold: [0, 1] });
  stuck.observe(rail);

  const state = { wrap, rail, update, drop() { sizes.disconnect(); near.disconnect(); stuck.disconnect(); wrap.removeEventListener('scroll', schedule); rail.remove(); wrap.classList.remove('has-rail'); } };
  live.add(state);
  return state;
}

function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const state of live) state.update();
  });
}

/** Give every `.table-wrap` under `root` a rail, now and as views render. */
export function watchRails(root) {
  const owned = new WeakSet();
  const scan = () => {
    for (const state of live) {
      if (state.wrap.isConnected && state.rail.previousElementSibling === state.wrap) continue;
      state.drop();
      live.delete(state);
      owned.delete(state.wrap);
    }
    for (const wrap of root.querySelectorAll('.table-wrap')) {
      if (owned.has(wrap)) continue;
      owned.add(wrap);
      mount(wrap);
    }
    schedule();
  };
  new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  document.fonts?.ready.then(schedule);
  scan();
}
