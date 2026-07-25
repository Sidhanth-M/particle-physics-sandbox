/**
 * Charge field — the second coupling layer.
 *
 * Where heat couples every material through temperature, charge couples the
 * conductive ones through current. The two meet at resistive heating: charge
 * running through a material raises its temperature, which then feeds straight
 * back into the phase-transition and combustion rules. A thin wire melting and
 * a charged detonator going off are both that coupling, not special cases.
 *
 * Propagation is an in-place max-flood with per-material decay. In-place means
 * current races along a run in the scan direction and creeps in the other, but
 * the scan direction alternates every frame, so it averages out — and current
 * arriving fast is the behaviour you want anyway.
 */

import { G, wakeAt, setCell, swapCells } from './grid.js';
import {
  CONDUCTS, EMITS_CHARGE, CHARGE_DECAY, RESISTANCE, IS_FLUID,
  IGNITION_TEMP, EXPLODE_POWER, EMPTY, SPARK, SWITCH, LAMP, FAN,
} from './materials.js';

/** Charge a source cell holds. */
const FULL = 255;
/** Charge bled off a non-source cell each frame, so current dies when cut. */
const LEAK = 10;
/** Current at or above this can jump a gap. */
const ARC_THRESHOLD = 150;
/** How far a spark will jump across empty space. */
const ARC_REACH = 3;
/** Heat pushed into an adjacent ignitable cell by current passing nearby. */
const IGNITE_HEAT = 26;
/** `aux` value that means a switch is open. 0 (the default) is closed. */
export const SWITCH_OPEN = 1;
/** Charge at which a lamp reads as lit. */
const LAMP_LIT = 40;
/**
 * How far downwind a fan reaches.
 *
 * Beyond this the draught stops and the fluid goes back to drifting on its own,
 * which is the right shape for airflow but means the number has to be generous:
 * at 8 a fan shoved things a few cells and released them almost immediately.
 */
const FAN_REACH = 20;
/**
 * Cells either side of the axis that the draught covers.
 *
 * Without this a fan only moved what sat exactly on its centre line, which for a
 * single-cell fan is a one-cell-wide thread — measured a 3.3-cell mean push on
 * smoke, barely distinguishable from the smoke's own drift. A draught has width.
 */
const FAN_SPREAD = 1;
/**
 * Cells a caught fluid is driven per frame.
 *
 * This has to beat the fluid's own `dispersion`, which is up to 5 cells a frame
 * for water — a one-cell nudge against that is indistinguishable from the
 * fluid's own spreading, and measured as such (+1.1 cells over 100 frames).
 */
const FAN_PUSH = 3;
/** Facing stored in a fan's `aux`: up, right, down, left. */
const FAN_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * Can charge enter cell `j`?
 *
 * An OPEN SWITCH is the one case where conducting depends on the cell rather
 * than the material, so this is the only per-cell gate in the propagation path.
 * It is also all a switch needs: an open one is a gap, and gaps are already
 * governed by the arc rule, so a switch with a wide enough break stays off while
 * a hair-thin one can still be jumped.
 */
function conductsInto(j) {
  const b = G.mat[j];
  if (!CONDUCTS[b]) return false;
  return !(b === SWITCH && G.aux[j] === SWITCH_OPEN);
}

/**
 * Push fluids along the fan's facing while it carries current.
 *
 * Walks the ray from the FAR end inward, for the same reason the gravity well
 * walks nearest-first: the outermost cell has to vacate before the one behind it
 * has anywhere to go, or only the first cell of the column ever moves.
 */
function fanBlow(i, x, y) {
  const d = FAN_DIRS[G.aux[i] & 3];
  const dx = d[0], dy = d[1], w = G.w, h = G.h;
  const px = -dy, py = dx;                   // perpendicular, for the draught's width
  for (let k = FAN_REACH; k >= 1; k--) {
    for (let o = -FAN_SPREAD; o <= FAN_SPREAD; o++) {
      const sx = x + dx * k + px * o, sy = y + dy * k + py * o;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      const si = sy * w + sx;
      const t = G.mat[si];
      if (t === EMPTY || !IS_FLUID[t]) continue;

      let cx = sx, cy = sy, ci = si;
      for (let s = 0; s < FAN_PUSH; s++) {
        const tx = cx + dx, ty = cy + dy;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) break;
        const ti = ty * w + tx;
        if (G.mat[ti] !== EMPTY) break;      // piled up against something
        swapCells(ci, ti);
        cx = tx; cy = ty; ci = ti;
      }
    }
  }
}

export const electricStats = { charged: 0, arcs: 0, ignitions: 0 };

export function resetElectricStats() {
  electricStats.charged = 0;
  electricStats.arcs = 0;
  electricStats.ignitions = 0;
}

/** True if this material takes part in the charge field at all. */
export const IS_ELECTRIC = new Uint8Array(CONDUCTS.length);
for (let t = 0; t < CONDUCTS.length; t++) {
  IS_ELECTRIC[t] = (CONDUCTS[t] || EMITS_CHARGE[t]) ? 1 : 0;
}

/**
 * Try to throw a spark across a gap to a conductor that is not touching.
 * This is what lets a switch work: two wire runs with air between them.
 */
function tryArc(i, x, y) {
  const w = G.w, h = G.h, mat = G.mat;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let d = 0; d < 4; d++) {
    const dx = dirs[d][0], dy = dirs[d][1];
    for (let s = 1; s <= ARC_REACH; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) break;
      const j = ny * w + nx, b = mat[j];
      if (b === EMPTY) continue;                 // keep looking across the gap
      if (s > 1 && conductsInto(j) && G.charge[j] < ARC_THRESHOLD) {
        // land the spark in the gap so the jump is visible, then energise
        const mx = x + dx, my = y + dy;
        const mi = my * w + mx;
        if (mat[mi] === EMPTY) setCell(mi, SPARK);
        G.charge[j] = ARC_THRESHOLD;
        wakeAt(nx, ny);
        electricStats.arcs++;
        return true;
      }
      break;                                     // hit something that is not a conductor
    }
  }
  return false;
}

/**
 * One cell's electrical update. Called from the heat pass, which is already
 * walking every awake chunk.
 */
export function electricStep(i, x, y, t) {
  const charge = G.charge, mat = G.mat, w = G.w, h = G.h;

  if (EMITS_CHARGE[t]) {
    charge[i] = FULL;
    wakeAt(x, y);
  }

  // Shade carries the visible state of a switch, and it is synced here rather
  // than only at the moment of toggling, because `setCell` randomises shade —
  // a freshly painted switch would otherwise show "open" while conducting.
  if (t === SWITCH) {
    const want = G.aux[i] === SWITCH_OPEN ? 2 + (i & 1) : (i & 1);
    if (G.shade[i] !== want) { G.shade[i] = want; wakeAt(x, y); }
    if (G.aux[i] === SWITCH_OPEN) {
      if (charge[i] !== 0) { charge[i] = 0; wakeAt(x, y); }   // an open switch holds nothing
      return;
    }
  }

  let c = charge[i];

  // Lamps must update on the way DOWN as well, so this sits above the
  // zero-charge early-out: otherwise a lamp goes dark only if it happens to be
  // re-visited while still carrying current, and stays lit after the cut.
  if (t === LAMP) {
    const want = c >= LAMP_LIT ? 2 + (i & 1) : (i & 1);
    if (G.shade[i] !== want) { G.shade[i] = want; wakeAt(x, y); }
  }

  if (c === 0) return;
  electricStats.charged++;
  if (t === FAN) fanBlow(i, x, y);

  // resistive heating: this is the whole reason wire melts and water warms
  const r = RESISTANCE[t];
  if (r > 0) {
    G.temp[i] += c * r;
    G.tempVersion++;
  }

  // push current outward to any conductor holding less than we can give it
  const give = c - CHARGE_DECAY[t];
  if (give > 0) {
    if (y > 0) spread(i - w, give, x, y - 1);
    if (y < h - 1) spread(i + w, give, x, y + 1);
    if (x > 0) spread(i - 1, give, x - 1, y);
    if (x < w - 1) spread(i + 1, give, x + 1, y);
  }

  // current running past something ignitable sets it off
  if (c >= ARC_THRESHOLD) {
    if (y > 0) igniteNeighbour(i - w);
    if (y < h - 1) igniteNeighbour(i + w);
    if (x > 0) igniteNeighbour(i - 1);
    if (x < w - 1) igniteNeighbour(i + 1);
    if (give > 0) tryArc(i, x, y);
  }

  // sources are refilled at the top of the next frame; everything else drains,
  // so cutting the supply actually turns the circuit off
  if (!EMITS_CHARGE[t]) {
    charge[i] = c > LEAK ? c - LEAK : 0;
    if (charge[i] > 0) wakeAt(x, y);
  }
}

function spread(j, give, nx, ny) {
  if (!conductsInto(j)) return;
  if (G.charge[j] >= give) return;
  G.charge[j] = give;
  wakeAt(nx, ny);
}

function igniteNeighbour(j) {
  const b = G.mat[j];
  if (b === EMPTY) return;
  if (IGNITION_TEMP[b] === Infinity) return;
  // nudge it over its own ignition point rather than detonating it directly,
  // so charges and fuels both go up through their normal rules
  if (G.temp[j] < IGNITION_TEMP[b] + 1) {
    G.temp[j] += IGNITE_HEAT;
    G.tempVersion++;
    if (EXPLODE_POWER[b] > 0) electricStats.ignitions++;
  }
}
