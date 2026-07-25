/**
 * Contact reactions and growth.
 *
 * This table is deliberately SMALL. Most of what looks like chemistry in this
 * sandbox is not written here at all — it emerges from the heat field (lava
 * quenching to stone, wood self-igniting, brine boiling dry) or from density
 * (oil floating, brine sinking). A row belongs here only when the outcome
 * depends on WHICH TWO materials touch, and cannot be expressed as a property
 * of either one alone.
 */

import { G, setCell, clearCell, wakeAt } from './grid.js';
import {
  MAT_COUNT, EMPTY, SAND, LAVA, MOLTEN_GLASS, SALT, WATER, BRINE, ICE,
  SEED, PLANT, VINE, FUNGUS, WOOD, FIRE, ACID, ACID_VAPOR, IS_CORRODIBLE,
} from './materials.js';

export const reactionStats = { fired: 0 };

/**
 * Pair lookup as flat typed arrays indexed by `low * MAT_COUNT + high`, so a
 * pair resolves the same way regardless of which cell is scanning.
 *
 * This was a Map first. With sand and water both appearing in the table,
 * `tryReact` runs for most cells and does four lookups each — roughly 576k
 * Map.get calls per frame at 480x300, which cost more than the entire rest of
 * the tick. The whole pair space is only MAT_COUNT^2 = 1024 entries, so a flat
 * array indexes it directly with no hashing and no result object.
 */
const PAIRS = MAT_COUNT * MAT_COUNT;
const R_PROB = new Float32Array(PAIRS);      // 0 means "no rule for this pair"
const R_LOW_PRODUCT = new Uint8Array(PAIRS);
const R_HIGH_PRODUCT = new Uint8Array(PAIRS);
const R_HEAT = new Float32Array(PAIRS);
let ruleCount = 0;

function rule(a, b, aProduct, bProduct, probability, heat = 0) {
  const low = Math.min(a, b), high = Math.max(a, b);
  const swapped = low !== a;
  const key = low * MAT_COUNT + high;
  R_LOW_PRODUCT[key] = swapped ? bProduct : aProduct;
  R_HIGH_PRODUCT[key] = swapped ? aProduct : bProduct;
  R_PROB[key] = probability;
  R_HEAT[key] = heat;
  ruleCount++;
}

// Sand fuses to glass where it touches lava. This is a CONTACT reaction and
// not a melting point: diffusion pulls a cell toward its neighbour average, so
// sand against 1300C lava only ever equilibrates near 650C and would never
// reach a melting threshold that fire could not also reach.
rule(SAND, LAVA, MOLTEN_GLASS, LAVA, 0.05);

// Salt dissolves into water, and melts ice below water's normal freezing point.
rule(SALT, WATER, EMPTY, BRINE, 0.35);
rule(SALT, ICE, EMPTY, WATER, 0.25);

// Seeds germinate in fresh water and are killed by salt water.
rule(SEED, WATER, PLANT, EMPTY, 0.04);
rule(SEED, BRINE, EMPTY, BRINE, 0.02);

// Acid attacking a solid gives off a corrosive vapour rather than nothing.
rule(ACID, SAND, ACID_VAPOR, EMPTY, 0.12);

// Fungus rots its way through wood.
rule(FUNGUS, WOOD, FUNGUS, FUNGUS, 0.004);

// Living matter chars instantly on lava contact.
rule(PLANT, LAVA, FIRE, LAVA, 0.35);
rule(VINE, LAVA, FIRE, LAVA, 0.35);

/** True if a material appears in any reaction row, so the hot loop can skip it. */
export const HAS_REACTION = new Uint8Array(MAT_COUNT);
/**
 * Highest probability any of a material's rules can fire at.
 *
 * Used as a single-random-number gate: rolling once per cell against this, then
 * rolling each pair against `prob / gate`, multiplies out to exactly `prob`.
 * Without it every reactive cell burns four Math.random() calls per frame, and
 * with sand and water both in the table that is most of the grid.
 */
const MAX_PROB = new Float32Array(MAT_COUNT);
for (let key = 0; key < PAIRS; key++) {
  const p = R_PROB[key];
  if (p === 0) continue;
  const low = (key / MAT_COUNT) | 0, high = key % MAT_COUNT;
  HAS_REACTION[low] = 1;
  HAS_REACTION[high] = 1;
  if (p > MAX_PROB[low]) MAX_PROB[low] = p;
  if (p > MAX_PROB[high]) MAX_PROB[high] = p;
}
// growth rules are unary, but still need these materials visited
HAS_REACTION[PLANT] = 1;
HAS_REACTION[VINE] = 1;

export function reactionCount() { return ruleCount; }

/**
 * Every row, as data. The codex renders itself from this rather than from a
 * hand-written list, so a reaction added to the table above documents itself and
 * cannot silently go missing from the guide.
 */
export function reactionRows() {
  const out = [];
  for (let key = 0; key < PAIRS; key++) {
    if (R_PROB[key] === 0) continue;
    out.push({
      low: (key / MAT_COUNT) | 0,
      high: key % MAT_COUNT,
      lowProduct: R_LOW_PRODUCT[key],
      highProduct: R_HIGH_PRODUCT[key],
      prob: R_PROB[key],
      heat: R_HEAT[key],
    });
  }
  return out;
}

export function reactionKeys() {
  return reactionRows().map(r => r.low * MAT_COUNT + r.high);
}

/** Materials that creep into empty space. Unary, so they are not table rows. */
export function growers() {
  const out = [];
  for (let t = 0; t < MAT_COUNT; t++) if (GROWS[t]) out.push(t);
  return out;
}

function fire(i, j, t, b, gate) {
  const key = t < b ? t * MAT_COUNT + b : b * MAT_COUNT + t;
  const prob = R_PROB[key];
  // the caller already rolled once against `gate`; this is the conditional half
  if (prob === 0 || Math.random() >= prob / gate) return false;

  const low = t < b ? i : j;
  const high = t < b ? j : i;
  const lowProduct = R_LOW_PRODUCT[key], highProduct = R_HIGH_PRODUCT[key];

  if (lowProduct === EMPTY) clearCell(low); else setCell(low, lowProduct);
  if (highProduct === EMPTY) clearCell(high); else setCell(high, highProduct);

  const heat = R_HEAT[key];
  if (heat !== 0) {
    G.temp[low] += heat;
    G.temp[high] += heat;
    G.tempVersion++;
  }
  reactionStats.fired++;
  return true;
}

/**
 * Plants and vines creep into empty space while they have water to draw on.
 * `aux` caps how far one strand can run, so a single seed cannot green the
 * entire world.
 */
const GROWTH_BUDGET = 40;

/** Only living matter grows. Everything else in the table must be conserved. */
const GROWS = new Uint8Array(MAT_COUNT);
GROWS[PLANT] = 1;
GROWS[VINE] = 1;

function tryGrow(i, x, y, t) {
  const w = G.w, h = G.h, mat = G.mat;
  if (!GROWS[t]) return false;
  if (G.aux[i] >= GROWTH_BUDGET) return false;

  // needs water within its 4-neighbourhood to grow at all
  let wet = false;
  if (y > 0 && mat[i - w] === WATER) wet = true;
  else if (y < h - 1 && mat[i + w] === WATER) wet = true;
  else if (x > 0 && mat[i - 1] === WATER) wet = true;
  else if (x < w - 1 && mat[i + 1] === WATER) wet = true;
  if (!wet || Math.random() > 0.06) return false;

  // plants climb, vines trail downward
  const dy = t === VINE ? 1 : -1;
  const ny = y + dy;
  if (ny < 0 || ny >= h) return false;

  const dx = (Math.random() * 3 | 0) - 1;   // -1, 0 or 1
  const nx = x + dx;
  if (nx < 0 || nx >= w) return false;

  const j = ny * w + nx;
  if (mat[j] !== EMPTY) return false;

  setCell(j, t);
  G.aux[j] = G.aux[i] + 1;
  G.aux[i] = GROWTH_BUDGET;                 // this cell is done growing
  wakeAt(nx, ny);
  return true;
}

/**
 * Run the reaction and growth rules for one cell. Called from the heat pass,
 * which is already walking every awake chunk — a separate pass would double
 * the per-frame scan for no benefit.
 */
export function tryReact(i, x, y, t) {
  if (tryGrow(i, x, y, t)) return true;

  const gate = MAX_PROB[t];
  if (gate === 0 || Math.random() >= gate) return false;   // one roll for all four neighbours

  const w = G.w, mat = G.mat;
  if (y > 0 && fire(i, i - w, t, mat[i - w], gate)) return true;
  if (y < G.h - 1 && fire(i, i + w, t, mat[i + w], gate)) return true;
  if (x > 0 && fire(i, i - 1, t, mat[i - 1], gate)) return true;
  if (x < w - 1 && fire(i, i + 1, t, mat[i + 1], gate)) return true;
  return false;
}
