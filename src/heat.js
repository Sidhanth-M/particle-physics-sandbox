/**
 * Temperature field: diffusion, phase transitions, combustion.
 *
 * This is the coupling layer. Every material reacts to one scalar, so
 * behaviours that would otherwise need explicit pair rules fall out for free —
 * lava quenching to stone in water, wood self-igniting near a fire, sand
 * fusing to glass. Nothing here knows about any specific material.
 *
 * Runs on the same chunk activation as movement: a cell whose temperature
 * moves more than WAKE_EPS wakes its chunk, so a cooling body keeps itself
 * alive until it reaches ambient and then sleeps.
 */

import { G, CHUNK, AMBIENT, F_BURNING, wakeAt, setCell, clearCell } from './grid.js';
import {
  CONDUCTIVITY, HAS_TRANSITION,
  MELT_POINT, MELT_PRODUCT, BOIL_POINT, BOIL_PRODUCT,
  FREEZE_POINT, FREEZE_PRODUCT, CONDENSE_POINT, CONDENSE_PRODUCT,
  SELF_HEAT, SELF_HEAT_CAP, IGNITION_TEMP, BURN_HEAT, BURN_FUEL, ASH_PRODUCT,
  EXPLODE_RADIUS, EXPLODE_POWER, WATERPROOF_BURN,
  EMPTY, WATER, ICE, SNOW, FIRE, SMOKE,
} from './materials.js';
import { tryReact, HAS_REACTION } from './reactions.js';
import { explode } from './explosions.js';
import { electricStep, IS_ELECTRIC } from './electric.js';

/**
 * Diffusion rate. The update is `T += K * conductivity * (avg4 - T)`, which is
 * stable for K * conductivity <= 1. Conductivity is clamped to [0,1] at table
 * build time, so K must stay <= 1.
 */
const K = 0.5;
/** Radiative loss toward room temperature. Guarantees energy leaves the system. */
const AMBIENT_BLEED = 0.004;
/** Temperature change below this does not count as activity. */
const WAKE_EPS = 0.25;
const TEMP_MIN = -273, TEMP_MAX = 6000;

/**
 * Counters for real phase changes.
 *
 * Diffing cell materials between frames CANNOT measure this: a falling stone
 * swapping with lava, or water flowing into an empty cell, both look like a
 * transition at that cell index. Only counting at the source is unambiguous.
 */
export const heatStats = { transitions: 0, ignitions: 0 };

/* ------------------------------ diffusion ------------------------------ */

function diffuse() {
  const w = G.w, h = G.h, cw = G.cw, ch = G.ch;
  const active = G.active, mat = G.mat, temp = G.temp, next = G.tempNext;

  next.set(temp);   // cells in sleeping chunks keep their value
  let touched = false;

  for (let cy = 0; cy < ch; cy++) {
    const crow = cy * cw;
    const yTop = cy * CHUNK, yBot = Math.min(yTop + CHUNK, h);
    for (let cx = 0; cx < cw; cx++) {
      if (!active[crow + cx]) continue;
      touched = true;
      const xL = cx * CHUNK, xR = Math.min(xL + CHUNK, w);

      for (let y = yTop; y < yBot; y++) {
        const row = y * w;
        for (let x = xL; x < xR; x++) {
          const i = row + x;
          const cur = temp[i];

          // out-of-bounds neighbours read as room temperature
          let sum = y > 0 ? temp[i - w] : AMBIENT;
          sum += y < h - 1 ? temp[i + w] : AMBIENT;
          sum += x > 0 ? temp[i - 1] : AMBIENT;
          sum += x < w - 1 ? temp[i + 1] : AMBIENT;

          let t = cur + K * CONDUCTIVITY[mat[i]] * (sum * 0.25 - cur);
          t += AMBIENT_BLEED * (AMBIENT - t);
          if (t < TEMP_MIN) t = TEMP_MIN; else if (t > TEMP_MAX) t = TEMP_MAX;
          next[i] = t;

          const d = t - cur;
          if (d > WAKE_EPS || d < -WAKE_EPS) wakeAt(x, y);
        }
      }
    }
  }

  const swap = G.temp; G.temp = G.tempNext; G.tempNext = swap;
  if (touched) G.tempVersion++;
}

/* ------------------------- transitions & burning ------------------------- */

/**
 * Replace a cell with its phase product, pinning the temperature to the
 * threshold that was crossed. That pin is the cheap stand-in for latent heat:
 * without it a cell that shoots far past a threshold would transition again
 * immediately, and ice would flash straight to steam. Every forward/reverse
 * threshold pair in the material table leaves a gap around this pinned value.
 */
function transition(i, product, pinTemp) {
  heatStats.transitions++;
  if (product === EMPTY) { clearCell(i); return; }
  setCell(i, product);
  G.temp[i] = pinTemp;
  G.tempVersion++;
}

function applyPhase(i, t, T) {
  if (T >= MELT_POINT[t]) { transition(i, MELT_PRODUCT[t], MELT_POINT[t]); return true; }
  if (T >= BOIL_POINT[t]) { transition(i, BOIL_PRODUCT[t], BOIL_POINT[t]); return true; }
  if (T <= FREEZE_POINT[t]) { transition(i, FREEZE_PRODUCT[t], FREEZE_POINT[t]); return true; }
  if (T <= CONDENSE_POINT[t]) { transition(i, CONDENSE_PRODUCT[t], CONDENSE_POINT[t]); return true; }
  return false;
}

function touchesWater(i, x, y) {
  const w = G.w, mat = G.mat;
  const wet = (b) => b === WATER || b === ICE || b === SNOW;
  if (y > 0 && wet(mat[i - w])) return true;
  if (y < G.h - 1 && wet(mat[i + w])) return true;
  if (x > 0 && wet(mat[i - 1])) return true;
  if (x < w - 1 && wet(mat[i + 1])) return true;
  return false;
}

/**
 * Combustion burns a cell IN PLACE rather than swapping it for a fire cell, so
 * a burning log still looks like a log. The heat it injects is what spreads
 * the fire; the visible flame is a separate FIRE cell spawned into the air
 * above it. `burnFuel` is what guarantees a fire eventually goes out.
 */
function combust(i, x, y, t) {
  const flags = G.flags, temp = G.temp, aux = G.aux, mat = G.mat, w = G.w;

  if ((flags[i] & F_BURNING) === 0) {
    if (temp[i] >= IGNITION_TEMP[t]) {
      flags[i] |= F_BURNING;
      aux[i] = BURN_FUEL[t];
      heatStats.ignitions++;
      wakeAt(x, y);
    }
    return;
  }

  if (!WATERPROOF_BURN[t] && touchesWater(i, x, y)) {
    flags[i] &= ~F_BURNING;
    if (temp[i] > 90) { temp[i] = 90; G.tempVersion++; }
    wakeAt(x, y);
    return;
  }

  temp[i] += BURN_HEAT[t];
  G.tempVersion++;

  if (aux[i] > 0) {
    aux[i]--;
    if (aux[i] === 0) { transition(i, ASH_PRODUCT[t], Math.min(temp[i], 400)); return; }
  }

  if (y > 0 && mat[i - w] === EMPTY) {
    const r = Math.random();
    if (r < 0.22) setCell(i - w, FIRE);
    else if (r < 0.30) setCell(i - w, SMOKE);
  }
  wakeAt(x, y);
}

/**
 * How often sleeping chunks get a reaction sweep.
 *
 * Contact reactions between two SETTLED materials — fungus rotting wood, salt
 * sitting in brine — never wake anything, so a purely activity-driven pass
 * would let their chunks sleep and the reaction would never fire at all. A
 * periodic full sweep costs 1/N of a scan and makes those reactions reachable.
 */
const SWEEP_INTERVAL = 16;

function react() {
  const w = G.w, h = G.h, cw = G.cw, ch = G.ch;
  const active = G.active, mat = G.mat;
  const sweepAll = (G.frame % SWEEP_INTERVAL) === 0;

  for (let cy = 0; cy < ch; cy++) {
    const crow = cy * cw;
    const yTop = cy * CHUNK, yBot = Math.min(yTop + CHUNK, h);
    for (let cx = 0; cx < cw; cx++) {
      if (!active[crow + cx] && !sweepAll) continue;
      const xL = cx * CHUNK, xR = Math.min(xL + CHUNK, w);

      for (let y = yTop; y < yBot; y++) {
        const row = y * w;
        for (let x = xL; x < xR; x++) {
          const i = row + x;
          const t = mat[i];
          if (t === EMPTY) continue;
          const thermal = HAS_TRANSITION[t], reactive = HAS_REACTION[t];
          const electric = IS_ELECTRIC[t] || G.charge[i] !== 0;
          if (!thermal && !reactive && !electric) continue;

          if (electric) electricStep(i, x, y, t);

          if (thermal) {
            // heat sources top themselves back up before anything else is judged
            const sh = SELF_HEAT[t];
            if (sh > 0) {
              const cap = SELF_HEAT_CAP[t];
              if (G.temp[i] < cap) {
                const t2 = G.temp[i] + sh;
                G.temp[i] = t2 > cap ? cap : t2;
                G.tempVersion++;
                wakeAt(x, y);
              }
            }

            // charges detonate rather than burn
            if (EXPLODE_POWER[t] > 0 && G.temp[i] >= IGNITION_TEMP[t]) {
              clearCell(i);
              explode(x, y, EXPLODE_RADIUS[t], EXPLODE_POWER[t]);
              continue;
            }

            if (applyPhase(i, t, G.temp[i])) continue;
            if (BURN_FUEL[t] > 0) combust(i, x, y, t);
          }

          // combustion or a phase change may have replaced the cell already
          if (reactive && mat[i] === t) tryReact(i, x, y, t);
        }
      }
    }
  }
}

export function stepHeat() {
  diffuse();
  react();
}
