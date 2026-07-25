/**
 * Simulation step: scan order + movement behaviours.
 *
 * Movement dispatches on material CATEGORY, never on material id. Powders,
 * liquids and gases share one displacement predicate that differs only in
 * which direction counts as "downhill" for density. That is what lets the
 * material table grow without this file growing with it.
 */

import {
  G, CHUNK, beginFrame, swapCells, setCell, clearCell, wakeIndex,
} from './grid.js';
import {
  CAT, CATEGORY, DENSITY, DISPERSION, FRICTION,
  CORROSIVE, CORROSION_RESIST, IS_FLUID, IS_CORRODIBLE, DOUSED_BY_WATER, BUOYANT,
  EMPTY, WATER, ICE, SMOKE,
} from './materials.js';
import { stepHeat } from './heat.js';
import { stepParticles, drawParticles, undrawParticles } from './particles.js';
import { beginBlastFrame } from './explosions.js';

/**
 * Can material `t` move into cell `j`?
 * Empty always yields. Fluids yield to anything heavier moving down, or
 * anything lighter moving up. Solids, powders and rigids never yield.
 */
function canSwapInto(t, j, goingDown) {
  const b = G.mat[j];
  if (b === EMPTY) return true;
  if (!IS_FLUID[b]) return false;
  return goingDown ? DENSITY[t] > DENSITY[b] : DENSITY[t] < DENSITY[b];
}

/**
 * Buoyancy: can liquid `t` rise into cell `j`?
 *
 * Deliberately NOT canSwapInto(..., false) — that treats empty space as always
 * enterable, which would make liquids fly upward off their own surface. A
 * liquid only floats through something denser than itself.
 */
function canFloatInto(t, j) {
  const b = G.mat[j];
  if (b === EMPTY || !IS_FLUID[b]) return false;
  return DENSITY[t] < DENSITY[b];
}

/** Slide along a row into the furthest reachable empty cell. */
function flowSideways(i, x, reach) {
  if (reach <= 0) return false;
  const w = G.w, mat = G.mat;
  const dir = Math.random() < 0.5 ? 1 : -1;
  let target = -1;

  for (let s = 1; s <= reach; s++) {
    const nx = x + dir * s;
    if (nx < 0 || nx >= w || mat[i + dir * s] !== EMPTY) break;
    target = i + dir * s;
  }
  if (target < 0) {
    for (let s = 1; s <= reach; s++) {
      const nx = x - dir * s;
      if (nx < 0 || nx >= w || mat[i - dir * s] !== EMPTY) break;
      target = i - dir * s;
    }
  }
  if (target < 0) return false;
  swapCells(i, target);
  return true;
}

function movePowder(i, x, y, t) {
  if (y + 1 >= G.h) return;
  const w = G.w, dn = i + w;
  if (canSwapInto(t, dn, true)) { swapCells(i, dn); return; }
  // friction 0 = always slides to a shallow pile, 1 = stacks in vertical columns
  if (Math.random() < FRICTION[t]) return;
  const dir = Math.random() < 0.5 ? 1 : -1;
  if (x + dir >= 0 && x + dir < w && canSwapInto(t, dn + dir, true)) { swapCells(i, dn + dir); return; }
  if (x - dir >= 0 && x - dir < w && canSwapInto(t, dn - dir, true)) { swapCells(i, dn - dir); return; }
}

function moveRigid(i, x, y, t) {
  if (y + 1 >= G.h) return;
  const dn = i + G.w;
  if (canSwapInto(t, dn, true)) swapCells(i, dn);
}

function moveLiquid(i, x, y, t) {
  const w = G.w;
  if (y + 1 < G.h) {
    const dn = i + w;
    if (canSwapInto(t, dn, true)) { swapCells(i, dn); return; }
    const dir = Math.random() < 0.5 ? 1 : -1;
    if (x + dir >= 0 && x + dir < w && canSwapInto(t, dn + dir, true)) { swapCells(i, dn + dir); return; }
    if (x - dir >= 0 && x - dir < w && canSwapInto(t, dn - dir, true)) { swapCells(i, dn - dir); return; }
  }
  // cannot sink: try to float up through anything heavier sitting on top of it
  if (y > 0) {
    const up = i - w;
    if (canFloatInto(t, up)) { swapCells(i, up); return; }
    const dir = Math.random() < 0.5 ? 1 : -1;
    if (x + dir >= 0 && x + dir < w && canFloatInto(t, up + dir)) { swapCells(i, up + dir); return; }
    if (x - dir >= 0 && x - dir < w && canFloatInto(t, up - dir)) { swapCells(i, up - dir); return; }
  }
  flowSideways(i, x, DISPERSION[t]);
}

function moveGas(i, x, y, t) {
  const aux = G.aux;
  if (aux[i] > 0) {
    aux[i]--;
    if (aux[i] === 0) { clearCell(i); return; }
    // a gas that cannot move still has to keep its chunk awake to finish decaying
    wakeIndex(i);
  }
  const w = G.w;
  if (y > 0) {
    const up = i - w;
    if (canSwapInto(t, up, false)) { swapCells(i, up); return; }
    const dir = Math.random() < 0.5 ? 1 : -1;
    if (x + dir >= 0 && x + dir < w && canSwapInto(t, up + dir, false)) { swapCells(i, up + dir); return; }
    if (x - dir >= 0 && x - dir < w && canSwapInto(t, up - dir, false)) { swapCells(i, up - dir); return; }
  }
  flowSideways(i, x, DISPERSION[t]);
}

/** Acid and friends. Returns true if the corrosive cell consumed itself. */
function tryEat(i, j, power, rate) {
  const b = G.mat[j];
  if (!IS_CORRODIBLE[b]) return false;
  if (Math.random() >= power * rate * (1 - CORROSION_RESIST[b])) return false;
  clearCell(j);
  clearCell(i);
  return true;
}

function corrode(i, x, y, t) {
  const w = G.w, power = CORROSIVE[t];
  if (y + 1 < G.h && tryEat(i, i + w, power, 0.5)) return true;
  if (x > 0 && tryEat(i, i - 1, power, 0.18)) return true;
  if (x + 1 < w && tryEat(i, i + 1, power, 0.18)) return true;
  if (y > 0 && tryEat(i, i - w, power, 0.08)) return true;
  return false;
}

/**
 * Free-standing flame in open air.
 *
 * It no longer lights anything directly — it just holds its own temperature
 * and lets the heat field do the igniting. That is the whole point of the
 * temperature layer: one scalar replaces every explicit "fire ignites X" rule.
 */
function updateFire(i, x, y) {
  const w = G.w, h = G.h, mat = G.mat;

  // Water still puts a FLAME out on contact; heat alone is too slow to look
  // right. Gated per material rather than applied to every ENERGY cell: a spark
  // dropped in water is not extinguished, it conducts, and that is the only way
  // charge ever crosses a pool now that there is no battery.
  if (DOUSED_BY_WATER[mat[i]] &&
      ((y > 0 && (mat[i - w] === WATER || mat[i - w] === ICE)) ||
       (y < h - 1 && (mat[i + w] === WATER || mat[i + w] === ICE)) ||
       (x > 0 && (mat[i - 1] === WATER || mat[i - 1] === ICE)) ||
       (x < w - 1 && (mat[i + 1] === WATER || mat[i + 1] === ICE)))) {
    clearCell(i);
    return;
  }

  // holding its temperature is now a material property (selfHeat), applied by heat.js

  if (G.aux[i] > 0) {
    G.aux[i]--;
    if (G.aux[i] === 0) {
      if (Math.random() < 0.3) setCell(i, SMOKE); else clearCell(i);
      return;
    }
  }

  G.shade[i] = (Math.random() * 4) | 0;  // flicker
  wakeIndex(i);

  // Only a flame rises. A spark stays where you put it for its short life, which
  // is what makes "zap this" a usable action at all.
  if (BUOYANT[mat[i]] && Math.random() < 0.82) {
    const r = (Math.random() * 7) | 0;
    let j = -1;
    if (r < 3) { if (y > 0) j = i - w; }
    else if (r === 3) { if (y > 0 && x > 0) j = i - w - 1; }
    else if (r === 4) { if (y > 0 && x + 1 < w) j = i - w + 1; }
    else if (r === 5) { if (x > 0) j = i - 1; }
    else { if (x + 1 < w) j = i + 1; }
    if (j >= 0 && mat[j] === EMPTY) swapCells(i, j);
  }
}

/**
 * A static source. `aux` holds the material it pours, written by the emitter
 * tool at placement time. It has to wake its own chunk every frame because
 * nothing else ever will — it never moves.
 */
function updateEmitter(i, x, y) {
  const t = G.aux[i];
  wakeIndex(i);
  if (t === EMPTY || Math.random() > 0.25) return;
  const w = G.w, mat = G.mat;
  let j = -1;
  if (y < G.h - 1 && mat[i + w] === EMPTY) j = i + w;
  else if (x > 0 && mat[i - 1] === EMPTY) j = i - 1;
  else if (x < w - 1 && mat[i + 1] === EMPTY) j = i + 1;
  else if (y > 0 && mat[i - w] === EMPTY) j = i - w;
  if (j >= 0) setCell(j, t);
}

function updateCell(i, x, y) {
  const t = G.mat[i];
  if (t === EMPTY) return;
  if (G.stamp[i] === G.frame) return;   // already moved into place this frame

  if (CORROSIVE[t] > 0 && corrode(i, x, y, t)) return;

  switch (CATEGORY[t]) {
    case CAT.POWDER: movePowder(i, x, y, t); break;
    case CAT.LIQUID: moveLiquid(i, x, y, t); break;
    case CAT.GAS:    moveGas(i, x, y, t); break;
    case CAT.RIGID:  moveRigid(i, x, y, t); break;
    case CAT.ENERGY: updateFire(i, x, y); break;
    case CAT.EMITTER: updateEmitter(i, x, y); break;
    // CAT.SOLID and CAT.NONE do nothing
  }
}

/**
 * One simulation tick.
 *
 * Rows are walked bottom-to-top globally (falling requires it) but only awake
 * chunks in each row are visited. Horizontal direction alternates per frame so
 * material does not drift consistently to one side.
 */
export function stepSim() {
  // airborne debris was painted into the grid for rendering; take it back so
  // the simulation only ever sees real cells
  undrawParticles();
  beginBlastFrame();
  beginFrame();
  const w = G.w, h = G.h, cw = G.cw, ch = G.ch, active = G.active;
  const ltr = (G.frame & 1) === 0;

  for (let cy = ch - 1; cy >= 0; cy--) {
    const crow = cy * cw;
    const yTop = cy * CHUNK;
    const yBot = Math.min(yTop + CHUNK, h) - 1;

    for (let y = yBot; y >= yTop; y--) {
      const row = y * w;
      if (ltr) {
        for (let cx = 0; cx < cw; cx++) {
          if (!active[crow + cx]) continue;
          const x0 = cx * CHUNK, x1 = Math.min(x0 + CHUNK, w);
          for (let x = x0; x < x1; x++) updateCell(row + x, x, y);
        }
      } else {
        for (let cx = cw - 1; cx >= 0; cx--) {
          if (!active[crow + cx]) continue;
          const x0 = cx * CHUNK, x1 = Math.min(x0 + CHUNK, w);
          for (let x = x1 - 1; x >= x0; x--) updateCell(row + x, x, y);
        }
      }
    }
  }

  stepHeat();
  stepParticles();
  drawParticles();
}
