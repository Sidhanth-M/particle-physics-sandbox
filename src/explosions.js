/**
 * Blast events.
 *
 * An explosion does three things: it destroys what cannot resist it, it throws
 * the wreckage outward as free particles, and it dumps a large amount of heat
 * into the temperature field. That third part is the interesting one — every
 * secondary effect (fires catching, water flashing to steam, nearby gunpowder
 * cooking off into a chain reaction) is emergent, not scripted.
 */

import { G, clearCell, setCell, wakeAt } from './grid.js';
import { spawnParticle } from './particles.js';
import {
  CAT, CATEGORY, BLAST_RESIST, EMPTY, FIRE, SMOKE,
} from './materials.js';

/**
 * A cascade of chain detonations must not be able to lock up the frame, so
 * blasts are budgeted per tick. Anything past the budget still detonates —
 * just on a later frame, because its heat remains in the field.
 */
const MAX_PER_FRAME = 24;
let firedThisFrame = 0;

export const blastStats = { total: 0, deferred: 0 };

export function beginBlastFrame() { firedThisFrame = 0; }

export function explode(cx, cy, radius, power) {
  if (firedThisFrame >= MAX_PER_FRAME) { blastStats.deferred++; return false; }
  firedThisFrame++;
  blastStats.total++;

  const w = G.w, h = G.h, mat = G.mat, temp = G.temp;
  const r2 = radius * radius;

  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= h) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const x = cx + dx;
      if (x < 0 || x >= w) continue;

      const i = y * w + x;
      const dist = Math.max(1, Math.sqrt(d2));
      const force = power / dist;

      // heat falls off with distance and drives every secondary effect
      temp[i] += force * 26;

      const t = mat[i];
      if (t === EMPTY) continue;

      if (force > BLAST_RESIST[t]) {
        const c = CATEGORY[t];
        // solid wreckage gets thrown; fluids and gases are simply blown away
        if ((c === CAT.SOLID || c === CAT.RIGID || c === CAT.POWDER) && Math.random() < 0.3) {
          const speed = 0.25 + force * 0.05;
          spawnParticle(x, y, (dx / dist) * speed, (dy / dist) * speed - 0.25, t);
        }
        clearCell(i);
      }
      wakeAt(x, y);
    }
  }

  // a burning core, so the blast leaves fire behind rather than a clean hole
  const coreR = Math.max(1, radius >> 2);
  for (let dy = -coreR; dy <= coreR; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= h) continue;
    for (let dx = -coreR; dx <= coreR; dx++) {
      if (dx * dx + dy * dy > coreR * coreR) continue;
      const x = cx + dx;
      if (x < 0 || x >= w) continue;
      const i = y * w + x;
      if (mat[i] !== EMPTY) continue;
      setCell(i, Math.random() < 0.7 ? FIRE : SMOKE);
    }
  }

  G.tempVersion++;
  return true;
}
