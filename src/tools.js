/**
 * Tools.
 *
 * Every tool is expressed as a callback over a brush footprint, so brush size,
 * shape and symmetry are handled once here rather than inside each tool. A new
 * tool only has to say what it does to one cell.
 */

import { G, setCell, clearCell, swapCells, wakeAt, AMBIENT } from './grid.js';
import {
  CAT, CATEGORY, FLAMMABILITY, IS_FLUID, DENSITY, STAMP,
  EMPTY, SAND, EMITTER, SWITCH, FAN,
} from './materials.js';
import { SWITCH_OPEN } from './electric.js';
import { explode } from './explosions.js';
import { spawnParticle } from './particles.js';
import { drawStamp, stampSpan } from './stamps.js';

/**
 * Tool metadata the UI reads back.
 *
 * `material` says whether the tool consumes the selected material — the panel
 * uses it to arm Paint when you click a material chip while a field tool is
 * held, which is the whole fix for "I was clicking materials and nothing
 * painted". `field` picks the dashed ring, so the cursor itself says which kind
 * of tool is live. `reach` is the tool's TRUE radius in cells: the ring must
 * describe where the tool acts, not what the brush slider happens to say.
 */
export const TOOL_LIST = [
  { id: 'paint',   name: 'Paint',      hint: 'Pour the selected material',
    material: true,  field: false, reach: (t) => t.size - 1 },
  { id: 'line',    name: 'Line',       hint: 'Drag a straight line',
    material: true,  field: false, reach: (t) => t.size - 1 },
  { id: 'rect',    name: 'Rectangle',  hint: 'Drag a hollow box',
    material: true,  field: false, reach: (t) => t.size - 1 },
  { id: 'fillrect', name: 'Filled Box', hint: 'Drag a solid box',
    material: true,  field: false, reach: (t) => t.size - 1 },
  { id: 'flood',   name: 'Flood Fill', hint: 'Replace a connected region',
    material: true,  field: false, reach: () => 0 },
  { id: 'pick',    name: 'Eyedropper', hint: 'Pick the material under the cursor',
    material: false, field: false, reach: () => 0 },
  { id: 'heat',    name: 'Heat Gun',   hint: 'Warm cells without changing them',
    material: false, field: true,  reach: (t) => t.size - 1 },
  { id: 'cool',    name: 'Freeze Gun', hint: 'Chill cells without changing them',
    material: false, field: true,  reach: (t) => t.size - 1 },
  { id: 'wind',    name: 'Wind',       hint: 'Push loose material along the drag',
    material: false, field: true,  reach: (t) => t.size - 1 },
  { id: 'well',    name: 'Gravity Well', hint: 'Drag material in — right-drag pushes out',
    material: false, field: true,  reach: (t) => wellRadius(t) },
  { id: 'vacuum',  name: 'Vacuum',     hint: 'Suck material in and delete it',
    material: false, field: true,  reach: (t) => t.size - 1 },
  { id: 'explode', name: 'Explode',    hint: 'Detonate a blast at the cursor',
    material: false, field: true,  reach: (t) => t.size * 2 + 4 },
  { id: 'emitter', name: 'Emitter',    hint: 'Place a source that keeps pouring',
    material: true,  field: false, reach: (t) => t.size - 1 },
];

export const TOOL_BY_ID = new Map(TOOL_LIST.map(t => [t.id, t]));

export const tool = {
  id: 'paint',
  size: 3,             // radius + 1, so 1 is a single cell
  shape: 'circle',     // 'circle' | 'square'
  scatter: 0.62,       // fraction of footprint cells a granular pour fills
  material: SAND,
  symX: false,
  symY: false,
  heatPower: 90,       // degrees per frame for the heat/freeze guns
  /**
   * The well reaches this many times further than the brush and pulls this many
   * cells per frame. Both scale off `size` so the existing slider drives them —
   * ponytail: a dedicated pair of sliders only if x3 still feels too small.
   */
  wellPower: 3,
};

/** Well radius in cells. Deliberately much wider than the brush footprint. */
export function wellRadius(t = tool) { return Math.max(2, (t.size - 1) * t.wellPower); }
/** Cells a captured particle is dragged per frame. */
export function wellStrength(t = tool) { return 1 + (t.size >> 2); }

/** Tools that act on a dragged start->end shape rather than continuously. */
export const DRAG_TOOLS = new Set(['line', 'rect', 'fillrect']);

/* ---------------------------- footprint core ---------------------------- */

/** Run `fn(x, y)` at a point and at each of its mirrored positions. */
function forEachSymmetric(x, y, fn) {
  fn(x, y);
  const mx = G.w - 1 - x, my = G.h - 1 - y;
  if (tool.symX) fn(mx, y);
  if (tool.symY) fn(x, my);
  if (tool.symX && tool.symY) fn(mx, my);
}

/** Visit every cell of the brush footprint centred on one point. */
function footprint(cx, cy, fn) {
  const r = tool.size - 1;
  const circle = tool.shape === 'circle';
  const w = G.w, h = G.h;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= h) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (circle && dx * dx + dy * dy > r * r) continue;
      const x = cx + dx;
      if (x < 0 || x >= w) continue;
      fn(y * w + x, x, y, dx, dy);
    }
  }
}

/** Footprint plus symmetry: the shape every continuous tool is applied through. */
export function brush(cx, cy, fn) {
  forEachSymmetric(cx, cy, (x, y) => footprint(x, y, fn));
}

/* ------------------------------- painting ------------------------------- */

function isPacked(t) {
  const c = CATEGORY[t];
  return c === CAT.SOLID || c === CAT.RIGID || c === CAT.EMITTER;
}

/** Placement rules: never overwrite packed terrain, but do displace fluids. */
export function paintCell(i, t) {
  const cur = G.mat[i];
  if (t === EMPTY) {
    if (cur !== EMPTY) clearCell(i);
    return;
  }
  if (cur === EMPTY) { setCell(i, t); return; }
  if (CATEGORY[t] === CAT.ENERGY && FLAMMABILITY[cur] > 0) { setCell(i, t); return; }
  if (IS_FLUID[cur] && !IS_FLUID[t]) { setCell(i, t); return; }
}

/**
 * Write one cell of a stamp. Goes through `paintCell`, so a stamp obeys exactly
 * the same placement rules as the brush — it cannot carve through packed terrain
 * — and then pins the shade the generator asked for, because `setCell`
 * randomises it and the shape is carried entirely by shade.
 */
function placeStampCell(x, y, mat, shade) {
  if (x < 0 || x >= G.w || y < 0 || y >= G.h) return;
  const i = y * G.w + x;
  paintCell(i, mat);
  if (G.mat[i] === mat) G.shade[i] = shade & 3;
}

function stampAt(cx, cy, name) {
  forEachSymmetric(cx, cy, (x, y) => drawStamp(name, x, y, tool.size, placeStampCell));
}

function pourAt(cx, cy, t) {
  const name = STAMP[t];
  if (name) { stampAt(cx, cy, name); return; }

  const packed = isPacked(t) || t === EMPTY;
  const solid = packed || tool.size === 1;
  brush(cx, cy, (i) => {
    if (!solid && Math.random() > tool.scatter) return;   // granular pour
    if (t === EMITTER) {
      setCell(i, EMITTER);
      G.aux[i] = tool.material === EMITTER ? SAND : tool.material;
      return;
    }
    paintCell(i, t);
  });
}

/* ---------------------------- component state ---------------------------- */

/**
 * Clicking a component that is ALREADY THERE adjusts it instead of repainting
 * it: a switch flips, a fan rotates. Only fires when the same material is
 * selected, so it can never surprise you while painting something else — the
 * falling-sand convention, and it avoids adding a mode to an app whose whole
 * problem was unlabelled modes.
 */
function tryAdjust(cx, cy) {
  const t = tool.material;
  if (t !== SWITCH && t !== FAN) return false;
  if (G.mat[cy * G.w + cx] !== t) return false;   // empty space still paints

  brush(cx, cy, (i, x, y) => {
    if (G.mat[i] !== t) return;
    if (t === SWITCH) {
      G.aux[i] = G.aux[i] === SWITCH_OPEN ? 0 : SWITCH_OPEN;
      G.charge[i] = 0;
    } else {
      G.aux[i] = (G.aux[i] + 1) & 3;
    }
    wakeAt(x, y);
  });
  return true;
}

/* ------------------------------ field tools ------------------------------ */

function addHeat(cx, cy, delta) {
  brush(cx, cy, (i, x, y) => {
    let t = G.temp[i] + delta;
    if (t < -273) t = -273; else if (t > 6000) t = 6000;
    G.temp[i] = t;
    wakeAt(x, y);
  });
  G.tempVersion++;
}

/** Nudge loose material one cell along the drag direction. */
function applyWind(cx, cy, dx, dy) {
  const w = G.w, h = G.h;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  if (sx === 0 && sy === 0) return;
  brush(cx, cy, (i, x, y) => {
    const t = G.mat[i];
    if (t === EMPTY || !IS_FLUID[t]) return;
    const nx = x + sx, ny = y + sy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
    const j = ny * w + nx;
    if (G.mat[j] === EMPTY) swapCells(i, j);
  });
  for (let k = 0; k < 4; k++) spawnParticle(cx, cy, sx * 0.6, sy * 0.6 - 0.2, EMPTY);
}

/**
 * Offsets inside radius `r`, sorted nearest-first. Cached because `r` only
 * changes when the brush slider moves, and the list is up to ~7,000 entries.
 */
let wellCache = { r: -1, dx: null, dy: null };
function wellOffsets(r) {
  if (wellCache.r === r) return wellCache;
  const list = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 === 0 || d2 > r * r) continue;
      list.push([d2, dx, dy]);
    }
  }
  list.sort((a, b) => a[0] - b[0]);
  wellCache = {
    r,
    dx: Int16Array.from(list, e => e[1]),
    dy: Int16Array.from(list, e => e[2]),
  };
  return wellCache;
}

/**
 * Drag loose material toward the cursor (`sign` 1) or away from it (`sign` -1).
 *
 * Two things the first version got wrong, both of which made the well feel
 * inert. It walked the footprint top-left to bottom-right, so an outer cell was
 * blocked by an inner one that had not moved out of the way yet — processing
 * NEAREST FIRST is what actually makes a column collapse inward. And it stepped
 * one cell along `Math.sign(dx)`, which for a shallow angle points 45 degrees
 * off the true radius; marching a real unit vector fixes the direction and lets
 * a cell travel several cells per frame.
 */
function pullToward(cx, cy, sign) {
  const w = G.w, h = G.h;
  const r = wellRadius(), steps = wellStrength();
  const off = wellOffsets(r);
  const n = off.dx.length;

  forEachSymmetric(cx, cy, (ax, ay) => {
    for (let k = 0; k < n; k++) {
      // pulling in: closest first. pushing out: farthest first, mirrored logic
      const idx = sign > 0 ? k : n - 1 - k;
      const dx = off.dx[idx], dy = off.dy[idx];
      let x = ax + dx, y = ay + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      let i = y * w + x;
      const t = G.mat[i];
      if (t === EMPTY || isPacked(t)) continue;

      const inv = sign / Math.sqrt(dx * dx + dy * dy);
      const ux = dx * inv, uy = dy * inv;
      let fx = x, fy = y;
      for (let s = 0; s < steps; s++) {
        fx -= ux; fy -= uy;
        const nx = Math.round(fx), ny = Math.round(fy);
        if (nx === x && ny === y) continue;              // sub-cell step, keep marching
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) break;
        const j = ny * w + nx;
        const b = G.mat[j];
        // shove aside anything lighter and fluid; anything else stops the drag
        if (b !== EMPTY && (!IS_FLUID[b] || DENSITY[b] >= DENSITY[t])) break;
        swapCells(i, j);
        x = nx; y = ny; i = j;
      }
    }
  });
}

function vacuum(cx, cy) {
  brush(cx, cy, (i) => { if (G.mat[i] !== EMPTY) clearCell(i); });
}

/* ------------------------------ flood fill ------------------------------ */

/** Scanline flood of the connected region sharing the clicked material. */
export function floodFill(sx, sy, t) {
  const w = G.w, h = G.h, mat = G.mat;
  const target = mat[sy * w + sx];
  if (target === t) return 0;

  const stack = [sx, sy];
  let filled = 0;
  while (stack.length) {
    const y = stack.pop(), x0 = stack.pop();
    let x = x0;
    while (x > 0 && mat[y * w + x - 1] === target) x--;
    let spanAbove = false, spanBelow = false;
    for (; x < w && mat[y * w + x] === target; x++) {
      const i = y * w + x;
      if (t === EMPTY) clearCell(i); else setCell(i, t);
      filled++;
      if (y > 0) {
        const up = mat[(y - 1) * w + x] === target;
        if (up && !spanAbove) { stack.push(x, y - 1); spanAbove = true; }
        else if (!up) spanAbove = false;
      }
      if (y < h - 1) {
        const dn = mat[(y + 1) * w + x] === target;
        if (dn && !spanBelow) { stack.push(x, y + 1); spanBelow = true; }
        else if (!dn) spanBelow = false;
      }
    }
  }
  return filled;
}

/* -------------------------------- shapes -------------------------------- */

/**
 * Where the last stamp of the current stroke landed. A drag calls the tool once
 * per frame, so without this a stamp is redrawn a cell apart and the result is a
 * smear rather than a row of objects.
 */
let lastStamp = null;

function stampStroke(x0, y0, x1, y1, name) {
  const span = Math.max(1, stampSpan(name, tool.size));
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + dx * s / steps);
    const y = Math.round(y0 + dy * s / steps);
    if (lastStamp && Math.hypot(x - lastStamp.x, y - lastStamp.y) < span) continue;
    stampAt(x, y, name);
    lastStamp = { x, y };
  }
}

export function stampLine(x0, y0, x1, y1, t) {
  const name = STAMP[t];
  if (name) { stampStroke(x0, y0, x1, y1, name); return; }

  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) { pourAt(x1, y1, t); return; }
  for (let s = 0; s <= steps; s++) {
    pourAt(Math.round(x0 + dx * s / steps), Math.round(y0 + dy * s / steps), t);
  }
}

function stampRect(x0, y0, x1, y1, t, filled) {
  const lx = Math.min(x0, x1), hx = Math.max(x0, x1);
  const ly = Math.min(y0, y1), hy = Math.max(y0, y1);
  for (let y = ly; y <= hy; y++) {
    for (let x = lx; x <= hx; x++) {
      if (!filled && x !== lx && x !== hx && y !== ly && y !== hy) continue;
      forEachSymmetric(x, y, (px, py) => {
        if (px < 0 || px >= G.w || py < 0 || py >= G.h) return;
        paintCell(py * G.w + px, t);
      });
    }
  }
}

/* -------------------------------- driver -------------------------------- */

let dragStart = null;

/** Called on pointer down. `erase` is true for the right mouse button. */
export function toolDown(x, y, erase) {
  const t = erase ? EMPTY : tool.material;
  lastStamp = null;                 // a new stroke always places its first object
  if (DRAG_TOOLS.has(tool.id)) { dragStart = { x, y, erase }; return; }
  if (!erase && tool.id === 'paint' && tryAdjust(x, y)) return;

  switch (tool.id) {
    case 'flood': forEachSymmetric(x, y, (px, py) => floodFill(px, py, t)); break;
    case 'pick': if (G.mat[y * G.w + x] !== EMPTY) tool.material = G.mat[y * G.w + x]; break;
    case 'explode': forEachSymmetric(x, y, (px, py) => explode(px, py, tool.size * 2 + 4, tool.size * 5 + 12)); break;
    case 'emitter': pourAt(x, y, erase ? EMPTY : EMITTER); break;
    default: toolDrag(x, y, x, y, erase);
  }
}

/** Called each frame while the pointer is held. */
export function toolDrag(x0, y0, x1, y1, erase) {
  const t = erase ? EMPTY : tool.material;
  if (DRAG_TOOLS.has(tool.id)) return;   // those only commit on release

  switch (tool.id) {
    case 'paint': stampLine(x0, y0, x1, y1, t); break;
    case 'emitter': pourAt(x1, y1, erase ? EMPTY : EMITTER); break;
    case 'heat': addHeat(x1, y1, erase ? -tool.heatPower : tool.heatPower); break;
    case 'cool': addHeat(x1, y1, erase ? tool.heatPower : -tool.heatPower); break;
    case 'wind': applyWind(x1, y1, x1 - x0, y1 - y0); break;
    case 'well': pullToward(x1, y1, erase ? -1 : 1); break;
    case 'vacuum': vacuum(x1, y1); break;
    case 'flood': case 'pick': case 'explode': break;
    default: break;
  }
}

/** Called on pointer release. Commits the drag-shape tools. */
export function toolUp(x, y) {
  lastStamp = null;
  if (!dragStart) return;
  const t = dragStart.erase ? EMPTY : tool.material;
  switch (tool.id) {
    case 'line': stampLine(dragStart.x, dragStart.y, x, y, t); break;
    case 'rect': stampRect(dragStart.x, dragStart.y, x, y, t, false); break;
    case 'fillrect': stampRect(dragStart.x, dragStart.y, x, y, t, true); break;
  }
  dragStart = null;
}

export function currentDragStart() { return dragStart; }
export function cancelDrag() { dragStart = null; lastStamp = null; }
