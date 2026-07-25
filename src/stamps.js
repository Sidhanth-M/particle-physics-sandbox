/**
 * Procedural object stamps.
 *
 * Painting Plant, Fungus or Battery with a scatter brush produced a blob of one
 * flat colour — nothing about it read as a plant, a mushroom or a battery. These
 * generators draw the SHAPE instead, and they are functions of brush size rather
 * than hand-authored bitmaps, so one mushroom scales from 3 cells to 30 without
 * a second sprite.
 *
 * Two deliberate constraints:
 *
 * 1. **Pure geometry.** Every generator writes through a `place(x, y, mat, shade)`
 *    callback and touches no grid state. The brush supplies a callback with the
 *    painting rules (never overwrite packed terrain), presets supply one that
 *    writes directly. That is also what keeps this module out of an import cycle
 *    with `tools.js`.
 * 2. **Shape comes from shade, not from new materials.** Every material already
 *    carries four palette colours. A mushroom is legible because its cap uses the
 *    dark pair and its stem the pale pair — no MUSHROOM_CAP material required.
 */

import { PLANT, FUNGUS, BATTERY, WIRE, WOOD } from './materials.js';

/* --------------------------------- plants --------------------------------- */

/**
 * A plant sprig: stem with tapered leaves, growing UP from the cursor.
 * Shade 2 is the dark stem, shade 3 the bright leaf, shade 1 the tip bud.
 */
export function sprig(cx, cy, size, place) {
  const h = 2 + Math.round(size * 1.4);
  const maxLeaf = Math.max(1, Math.round(size * 0.7));
  // A slight lean, so a dragged row of sprigs is not a row of identical bars.
  // The bud has to follow the same curve: pinning it to `cx` left it floating two
  // cells off the tip at size 16, because the lean reaches -2 there.
  const lean = (k) => cx + Math.round(Math.sin(k * 0.45) * size * 0.12);

  for (let k = 0; k < h; k++) {
    const y = cy - k;
    const x = lean(k);
    place(x, y, PLANT, 2);

    if (k < 2 || k % 2 === 1) continue;          // bare near the base, then alternating
    const len = Math.max(1, Math.round(maxLeaf * (1 - k / h)));   // shorter toward the tip
    for (let d = 1; d <= len; d++) {
      const droop = Math.round(d * 0.5);
      place(x - d, y + droop, PLANT, 3);
      place(x + d, y + droop, PLANT, 3);
    }
  }
  place(lean(h), cy - h, PLANT, 1);              // bud, on the stem's own curve
}

/**
 * A mushroom: dome cap on a pale stem. The cap's bottom row uses the lighter
 * shade so its rim reads as an edge rather than dissolving into the dome.
 */
export function mushroom(cx, cy, size, place) {
  const capR = Math.max(1, Math.round(size * 0.8));
  const stemH = Math.max(1, Math.round(size * 0.7));
  const stemHalf = size <= 2 ? 0 : Math.max(0, Math.round(size * 0.18));
  const capY = cy - stemH;

  for (let k = 0; k < stemH; k++) {
    for (let dx = -stemHalf; dx <= stemHalf; dx++) {
      place(cx + dx, cy - k, FUNGUS, dx === stemHalf && stemHalf > 0 ? 3 : 2);
    }
  }

  const capH = Math.max(1, Math.round(capR * 0.75));
  for (let dy = 0; dy <= capH; dy++) {
    const frac = dy / (capH + 0.5);
    const wide = Math.round(capR * Math.sqrt(1 - frac * frac));
    for (let dx = -wide; dx <= wide; dx++) {
      place(cx + dx, capY - dy, FUNGUS, dy === 0 ? 1 : 0);
    }
  }
}

/* -------------------------------- hardware -------------------------------- */

/**
 * A battery cell: bodied block with a contrasting band and two wire terminals,
 * so it can be wired into a circuit the way the Circuit Board preset does by
 * hand rather than being a featureless green square.
 */
export function battery(cx, cy, size, place) {
  const halfW = Math.max(1, Math.round(size * 0.55));
  const halfH = Math.max(1, Math.round(size * 0.75));

  for (let dy = -halfH; dy <= halfH; dy++) {
    for (let dx = -halfW; dx <= halfW; dx++) {
      const edge = dx === -halfW || dx === halfW || dy === -halfH || dy === halfH;
      const band = halfH >= 3 && Math.abs(dy) <= halfH - 2 && Math.abs(dy) >= halfH - 3;
      place(cx + dx, cy + dy, BATTERY, edge ? 2 : band ? 3 : 0);
    }
  }

  const ty = Math.max(1, Math.round(halfH * 0.55));
  const nub = Math.max(1, Math.round(size * 0.35));
  for (let d = 1; d <= nub; d++) {
    place(cx + halfW + d, cy - ty, WIRE, 1);
    place(cx + halfW + d, cy + ty, WIRE, 1);
  }
}

/* --------------------------------- scenery --------------------------------- */

/**
 * A tree: wood trunk under a plant canopy. Used by the Forest Fire preset, whose
 * trees were bare trunks — a forest fire with nothing to catch but the trunk.
 * The canopy is PLANT, so it ignites, burns and chars through the ordinary
 * combustion rules with nothing scripted for it.
 */
export function tree(cx, cy, size, place) {
  const h = 4 + Math.round(size * 1.6);
  const trunkHalf = size >= 6 ? 1 : 0;
  for (let k = 0; k < h; k++) {
    for (let dx = -trunkHalf; dx <= trunkHalf; dx++) {
      place(cx + dx, cy - k, WOOD, dx === trunkHalf && trunkHalf > 0 ? 2 : 0);
    }
  }

  const r = Math.max(2, Math.round(size * 0.9));
  const top = cy - h;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy * 1.15);       // wider than tall
      if (d > r) continue;
      if (d > r - 1 && Math.random() < 0.45) continue;   // ragged silhouette
      place(cx + dx, top + dy, PLANT, d > r * 0.6 ? 3 : 0);
    }
  }
}

/* --------------------------------- registry --------------------------------- */

/**
 * `span` is the stamp's width in cells. The brush uses it for drag spacing:
 * re-stamping every frame of a drag produces a smear, not a row of objects.
 */
export const STAMPS = {
  // the lean shifts the stem sideways, so it counts toward the width — leaving it
  // out under-reports the span and a dragged row of sprigs overlaps into a hedge
  sprig: {
    draw: sprig,
    span: (s) => 2 * (Math.max(1, Math.round(s * 0.7)) + Math.round(s * 0.12)) + 1,
  },
  mushroom: { draw: mushroom, span: (s) => 2 * Math.max(1, Math.round(s * 0.8)) + 1 },
  battery: {
    draw: battery,
    span: (s) => 2 * Math.max(1, Math.round(s * 0.55)) + 1 + Math.max(1, Math.round(s * 0.35)),
  },
  tree: { draw: tree, span: (s) => 2 * Math.max(2, Math.round(s * 0.9)) + 1 },
};

export function drawStamp(name, cx, cy, size, place) {
  const s = STAMPS[name];
  if (!s) return false;
  s.draw(cx, cy, size, place);
  return true;
}

export function stampSpan(name, size) {
  const s = STAMPS[name];
  return s ? s.span(size) : 1;
}
