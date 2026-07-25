/**
 * Free-particle layer: airborne debris with real velocity.
 *
 * The grid can only express one material per cell moving one step per frame,
 * which is why explosions looked like deletion rather than force. Particles
 * live OUTSIDE the grid, integrate under gravity, and write themselves back
 * into a cell when they land.
 *
 * They are made visible by stamping them into `mat` at the very end of a tick
 * and clearing them at the very start of the next one, so the simulation never
 * sees them as real cells and the renderer needs no extra draw call.
 */

import { G, setCell } from './grid.js';
import { EMPTY } from './materials.js';

const MAX = 2000;
const GRAVITY = 0.06;
const DRAG = 0.995;

const px = new Float32Array(MAX);
const py = new Float32Array(MAX);
const vx = new Float32Array(MAX);
const vy = new Float32Array(MAX);
const pmat = new Uint8Array(MAX);
const plife = new Uint16Array(MAX);
let count = 0;

/** Cells this layer painted last frame, so they can be taken back cleanly. */
const stamped = new Int32Array(MAX);
let stampedCount = 0;

export const particleStats = { alive: 0, spawned: 0, landed: 0 };

export function particleCount() { return count; }

export function clearParticles() {
  count = 0;
  stampedCount = 0;
  particleStats.alive = 0;
}

export function spawnParticle(x, y, dx, dy, mat) {
  if (count >= MAX) return false;
  px[count] = x; py[count] = y;
  vx[count] = dx; vy[count] = dy;
  pmat[count] = mat;
  plife[count] = 240;
  count++;
  particleStats.spawned++;
  return true;
}

/** Drop a particle back into the grid at the nearest free cell. */
function land(k, cx, cy) {
  const w = G.w, h = G.h, mat = G.mat;
  if (cx >= 0 && cx < w && cy >= 0 && cy < h) {
    const i = cy * w + cx;
    if (mat[i] === EMPTY) { setCell(i, pmat[k]); particleStats.landed++; return; }
  }
  // first choice was taken; try the ring around it before giving up
  for (let dy = -1; dy <= 1; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= w) continue;
      const i = y * w + x;
      if (mat[i] === EMPTY) { setCell(i, pmat[k]); particleStats.landed++; return; }
    }
  }
  // nowhere to go: the debris is simply lost rather than overwriting anything
}

function removeAt(k) {
  count--;
  if (k !== count) {
    px[k] = px[count]; py[k] = py[count];
    vx[k] = vx[count]; vy[k] = vy[count];
    pmat[k] = pmat[count]; plife[k] = plife[count];
  }
}

export function stepParticles() {
  const w = G.w, h = G.h, mat = G.mat;
  for (let k = count - 1; k >= 0; k--) {
    vy[k] += GRAVITY;
    vx[k] *= DRAG;
    vy[k] *= DRAG;

    const oldX = px[k] | 0, oldY = py[k] | 0;
    const nx = px[k] + vx[k];
    const ny = py[k] + vy[k];
    const cx = Math.round(nx), cy = Math.round(ny);

    if (cx < 0 || cx >= w || cy < 0 || cy >= h) { removeAt(k); continue; }

    // anything solid in the way ends the flight at the last free cell
    if (mat[cy * w + cx] !== EMPTY) {
      land(k, oldX, oldY);
      removeAt(k);
      continue;
    }

    px[k] = nx; py[k] = ny;
    if (--plife[k] === 0) { land(k, cx, cy); removeAt(k); }
  }
  particleStats.alive = count;
}

/** Paint the live particles into the grid so the renderer picks them up. */
export function drawParticles() {
  const w = G.w, mat = G.mat, shade = G.shade;
  stampedCount = 0;
  for (let k = 0; k < count; k++) {
    const x = px[k] | 0, y = py[k] | 0;
    const i = y * w + x;
    if (mat[i] !== EMPTY) continue;
    mat[i] = pmat[k];
    shade[i] = k & 3;
    stamped[stampedCount++] = i;
  }
}

/** Take those cells back before the simulation runs. */
export function undrawParticles() {
  const mat = G.mat;
  for (let s = 0; s < stampedCount; s++) mat[stamped[s]] = EMPTY;
  stampedCount = 0;
}
