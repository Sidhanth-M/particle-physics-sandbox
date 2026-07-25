/**
 * Charge field — the second coupling layer.
 *
 * Where heat couples every material through temperature, charge couples the
 * conductive ones through current. The two meet at resistive heating: charge
 * running through a material raises its temperature, which then feeds straight
 * back into the phase-transition and combustion rules. Brine boiling itself dry
 * to salt and a charged detonator going off are both that coupling, not special
 * cases.
 *
 * There is deliberately no permanent supply. SPARK is the only source and it
 * lives 8-22 frames, so current is something you apply and watch the
 * consequences of, not something you wire up — the circuit-building materials
 * were removed on purpose.
 *
 * Propagation is an in-place max-flood with per-material decay. In-place means
 * current races along a run in the scan direction and creeps in the other, but
 * the scan direction alternates every frame, so it averages out — and current
 * arriving fast is the behaviour you want anyway.
 */

import { G, wakeAt, setCell } from './grid.js';
import {
  CONDUCTS, EMITS_CHARGE, CHARGE_DECAY, RESISTANCE,
  IGNITION_TEMP, EXPLODE_POWER, EMPTY, SPARK,
} from './materials.js';

/** Charge a source cell holds. */
const FULL = 255;
/** Charge bled off a non-source cell each frame, so current dies when cut. */
const LEAK = 10;
/** Current at or above this can jump a gap. */
const ARC_THRESHOLD = 150;
/** How far a spark will jump across empty space. */
const ARC_REACH = 3;
/**
 * Heat pushed into an adjacent ignitable cell by current passing nearby.
 *
 * Was 26, tuned against a battery that supplied current forever — at that rate
 * it did not matter how long ignition took. A spark gives roughly ten useful
 * frames before it expires and the charge drains, and 26 got gunpowder to 194 C
 * against a 250 C ignition point before falling back: close, and reliably not
 * close enough. Only materials with a finite `ignitionTemp` are affected, so
 * this cannot boil water or melt anything by itself.
 */
const IGNITE_HEAT = 55;

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
      if (s > 1 && CONDUCTS[b] && G.charge[j] < ARC_THRESHOLD) {
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

  const c = charge[i];
  if (c === 0) return;
  electricStats.charged++;

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
  if (!CONDUCTS[G.mat[j]]) return;
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
