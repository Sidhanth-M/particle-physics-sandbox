/**
 * Grid storage + chunk activation.
 *
 * The whole point of this module is that cost should scale with ACTIVITY, not
 * with grid area. The world is diced into 32x32 chunks; any write to a cell
 * wakes its chunk (and its neighbours, if the cell sits on a chunk border).
 * `stepSim` only walks awake chunks, so a settled sand pile costs nothing.
 */

import { LIFE_MIN, LIFE_SPAN, SPAWN_TEMP, INHERIT_TEMP, EMPTY } from './materials.js';

export const CHUNK = 32;
const CHUNK_SHIFT = 5;
const CHUNK_MASK = CHUNK - 1;

/** Persistent per-cell flag bits (transient "moved" state lives in `stamp`). */
export const F_BURNING = 1 << 0;

/**
 * Room temperature, in degrees C.
 *
 * A live binding rather than a constant: importers see changes without any
 * plumbing, which is why `heat.js` needs no knowledge that this is adjustable.
 */
export let AMBIENT = 20;
export const AMBIENT_DEFAULT = 20, AMBIENT_MIN = -100, AMBIENT_MAX = 600;

/**
 * Set room temperature and let the world drift toward it.
 *
 * Every chunk is woken because the ambient bleed is only applied inside AWAKE
 * chunks — a settled scene would otherwise ignore the new value completely until
 * something else happened to disturb it. One wake is enough: diffusion re-wakes
 * any cell whose temperature is still moving, so the drift sustains itself and
 * stops on its own at equilibrium.
 */
export function setAmbient(v) {
  const next = Math.max(AMBIENT_MIN, Math.min(AMBIENT_MAX, Math.round(v)));
  if (next === AMBIENT) return;
  AMBIENT = next;
  if (!G.active) return;                  // called before the grid exists
  G.active.fill(1);
  G.activeNext.fill(1);
  G.tempVersion++;
}

export const G = {
  w: 0, h: 0, n: 0,
  cw: 0, ch: 0, cn: 0,
  mat: null,     // Uint8Array   material id
  shade: null,   // Uint8Array   colour variant 0..3
  aux: null,     // Uint8Array   per-material scratch (lifetime, fuel, growth)
  flags: null,   // Uint8Array   persistent bits (F_*)
  temp: null,     // Float32Array degrees C
  tempNext: null, // Float32Array diffusion write buffer, swapped with `temp`
  charge: null,   // Uint8Array   electrical charge 0..255
  stamp: null,   // Uint32Array  frame number this cell last moved on
  active: null,      // Uint8Array  chunks to simulate this frame
  activeNext: null,  // Uint8Array  chunks to simulate next frame
  frame: 1,
  /**
   * Bumped whenever `temp` actually changes value. The renderer uploads the
   * temperature texture only when this moves, which keeps 576KB of unchanging
   * float data off the bus every frame.
   */
  tempVersion: 1,
};

export function initGrid(w, h) {
  const n = w * h;
  const cw = Math.ceil(w / CHUNK), ch = Math.ceil(h / CHUNK);
  G.w = w; G.h = h; G.n = n;
  G.cw = cw; G.ch = ch; G.cn = cw * ch;
  G.mat = new Uint8Array(n);
  G.shade = new Uint8Array(n);
  G.aux = new Uint8Array(n);
  G.flags = new Uint8Array(n);
  G.temp = new Float32Array(n).fill(AMBIENT);
  G.tempNext = new Float32Array(n).fill(AMBIENT);
  G.charge = new Uint8Array(n);
  G.stamp = new Uint32Array(n);
  G.active = new Uint8Array(G.cn).fill(1);      // simulate everything on frame 1
  G.activeNext = new Uint8Array(G.cn).fill(1);
  G.frame = 1;
  G.tempVersion++;
}

/**
 * Reallocate to a new size, preserving the overlapping top-left region.
 * Used when the viewport resizes.
 */
export function resizeGrid(w, h) {
  if (w === G.w && h === G.h) return;
  const old = { w: G.w, h: G.h, mat: G.mat, shade: G.shade, aux: G.aux, flags: G.flags, temp: G.temp, charge: G.charge };
  initGrid(w, h);
  if (!old.mat) return;
  const cwid = Math.min(old.w, w), chgt = Math.min(old.h, h);
  for (let y = 0; y < chgt; y++) {
    const src = y * old.w, dst = y * w;
    for (let x = 0; x < cwid; x++) {
      G.mat[dst + x] = old.mat[src + x];
      G.shade[dst + x] = old.shade[src + x];
      G.aux[dst + x] = old.aux[src + x];
      G.flags[dst + x] = old.flags[src + x];
      G.temp[dst + x] = old.temp[src + x];
      G.charge[dst + x] = old.charge[src + x];
    }
  }
}

export function clearGrid() {
  G.mat.fill(EMPTY);
  G.flags.fill(0);
  G.aux.fill(0);
  G.temp.fill(AMBIENT);
  G.charge.fill(0);
  G.active.fill(1);
  G.activeNext.fill(1);
  G.tempVersion++;
}

export function countParticles() {
  const mat = G.mat, n = G.n;
  let c = 0;
  for (let i = 0; i < n; i++) if (mat[i] !== EMPTY) c++;
  return c;
}

/** Wake the chunk containing (x, y), plus neighbours when on a chunk border. */
export function wakeAt(x, y) {
  const cw = G.cw, ch = G.ch;
  const cx = x >> CHUNK_SHIFT, cy = y >> CHUNK_SHIFT;
  const c = cy * cw + cx;
  G.active[c] = 1;
  G.activeNext[c] = 1;

  const lx = x & CHUNK_MASK, ly = y & CHUNK_MASK;
  if (lx !== 0 && lx !== CHUNK_MASK && ly !== 0 && ly !== CHUNK_MASK) return;

  // ponytail: on a border, wake the full 3x3 neighbourhood instead of working
  // out which side is actually affected. Over-waking costs a neighbour one idle
  // frame; under-waking freezes material mid-fall. Narrow it only if profiling
  // shows border writes dominating.
  const y0 = cy > 0 ? cy - 1 : 0, y1 = cy + 1 < ch ? cy + 1 : ch - 1;
  const x0 = cx > 0 ? cx - 1 : 0, x1 = cx + 1 < cw ? cx + 1 : cw - 1;
  for (let j = y0; j <= y1; j++) {
    const row = j * cw;
    for (let i = x0; i <= x1; i++) {
      G.active[row + i] = 1;
      G.activeNext[row + i] = 1;
    }
  }
}

export function wakeIndex(i) {
  const y = (i / G.w) | 0;
  wakeAt(i - y * G.w, y);
}

/** Write a material into a cell, randomising its shade and seeding its lifetime. */
export function setCell(i, t) {
  G.mat[i] = t;
  G.shade[i] = (Math.random() * 4) | 0;
  G.flags[i] = 0;
  G.charge[i] = 0;          // a new material does not inherit the old one's current
  const lo = LIFE_MIN[t];
  G.aux[i] = lo === 0 ? 0 : Math.min(255, lo + ((Math.random() * LIFE_SPAN[t]) | 0));
  // materials with an inherent temperature (lava, ice, fire) bring it with them
  const st = SPAWN_TEMP[t];
  if (st !== INHERIT_TEMP) { G.temp[i] = st; G.tempVersion++; }
  wakeIndex(i);
}

/** Empty a cell without the shade/lifetime work. */
export function clearCell(i) {
  G.mat[i] = EMPTY;
  G.flags[i] = 0;
  G.aux[i] = 0;
  G.charge[i] = 0;
  wakeIndex(i);
}

/** Exchange two cells and mark both as having moved this frame. */
export function swapCells(a, b) {
  const mat = G.mat, shade = G.shade, aux = G.aux, flags = G.flags, temp = G.temp;
  const charge = G.charge;
  let t = mat[a]; mat[a] = mat[b]; mat[b] = t;
  t = shade[a]; shade[a] = shade[b]; shade[b] = t;
  t = aux[a]; aux[a] = aux[b]; aux[b] = t;
  t = flags[a]; flags[a] = flags[b]; flags[b] = t;
  t = charge[a]; charge[a] = charge[b]; charge[b] = t;   // current rides along
  // heat travels with the material, but only counts as a change if it differs
  const ft = temp[a];
  if (ft !== temp[b]) { temp[a] = temp[b]; temp[b] = ft; G.tempVersion++; }
  G.stamp[a] = G.frame; G.stamp[b] = G.frame;
  wakeIndex(a);
  wakeIndex(b);
}

/** Advance the frame counter and roll the chunk activation buffers. */
export function beginFrame() {
  G.frame = (G.frame + 1) >>> 0;
  const t = G.active;
  G.active = G.activeNext;
  G.activeNext = t;
  G.activeNext.fill(0);
}

export function awakeChunkCount() {
  const a = G.active;
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i];
  return n;
}
