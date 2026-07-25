/**
 * The guide, generated from the live tables.
 *
 * Nine reaction rows, dozens of phase transitions and every ignition point exist
 * only as numbers in `materials.js` and `reactions.js`. Finding them by playing
 * means guessing, and a hand-written list of them would be wrong the first time
 * anyone touched the tables.
 *
 * So nothing here is authored twice: every entry below the "Try this" section is
 * READ OUT of the same arrays the simulation runs on. Add a material or a
 * reaction and its entry appears with no edit to this file — and a self-check
 * asserts the counts match the tables, so one cannot drift from the other.
 */

import {
  MATERIALS, MAT_COUNT, CAT_NAME, CATEGORY, EMPTY,
  MELT_POINT, MELT_PRODUCT, BOIL_POINT, BOIL_PRODUCT,
  FREEZE_POINT, FREEZE_PRODUCT, CONDENSE_POINT, CONDENSE_PRODUCT,
  IGNITION_TEMP, BURN_FUEL, ASH_PRODUCT, EXPLODE_POWER, EXPLODE_RADIUS,
  CONDUCTS, EMITS_CHARGE, RESISTANCE, CHARGE_DECAY,
} from './materials.js';
import { reactionRows, growers } from './reactions.js';

const name = (t) => MATERIALS[t].name;
const product = (t) => (t === EMPTY ? 'nothing' : name(t));

/** Probability read as a rate, because "0.004" tells a player nothing. */
function rate(p) {
  if (p >= 0.3) return 'quickly';
  if (p >= 0.1) return 'steadily';
  if (p >= 0.02) return 'slowly';
  return 'very slowly';
}

const deg = (t) => `${Math.round(t)}°C`;

/* ------------------------------ generators ------------------------------ */

/**
 * A row's two sides are not symmetrical in what they mean to a reader: one side
 * is often consumed and the other often survives untouched. Printing the raw
 * products gives lines like "Sand + Acid → nothing + Acid Vapor", so consumed
 * and unchanged reactants move out of the arrow and into the sentence.
 */
function reactionEntries() {
  return reactionRows().map((r) => {
    const produced = [], consumed = [], unchanged = [];
    const side = (mat, prod) => {
      if (prod === EMPTY) consumed.push(name(mat));
      else if (prod === mat) unchanged.push(name(mat));
      else produced.push(name(prod));
    };
    side(r.low, r.lowProduct);
    side(r.high, r.highProduct);

    const rhs = [...new Set(produced)];        // fungus + fungus is one product
    const bits = [`Happens ${rate(r.prob)} on contact.`];
    if (consumed.length) bits.push(`${consumed.join(' and ')} is used up.`);
    if (unchanged.length) bits.push(`${unchanged.join(' and ')} is left as it was.`);
    if (r.heat > 0) bits.push(`Releases ${Math.round(r.heat)}°C.`);

    return {
      title: `${name(r.low)} + ${name(r.high)} → ${rhs.length ? rhs.join(' + ') : 'nothing'}`,
      detail: bits.join(' '),
      mats: [r.low, r.high],
    };
  });
}

/**
 * One entry per (material, threshold), not per material — so the count is
 * unambiguous and the parity check has something exact to compare against.
 */
function transitionEntries() {
  const kinds = [
    ['melts into', MELT_POINT, MELT_PRODUCT, 'above'],
    ['boils into', BOIL_POINT, BOIL_PRODUCT, 'above'],
    ['freezes into', FREEZE_POINT, FREEZE_PRODUCT, 'below'],
    ['condenses into', CONDENSE_POINT, CONDENSE_PRODUCT, 'below'],
  ];
  const out = [];
  for (let t = 1; t < MAT_COUNT; t++) {
    if (MATERIALS[t].hidden) continue;
    for (const [verb, point, prod, dir] of kinds) {
      const p = point[t];
      if (p === Infinity || p === -Infinity) continue;
      out.push({
        title: `${name(t)} ${verb} ${product(prod[t])}`,
        detail: `Whenever it goes ${dir} ${deg(p)}.`,
        mats: [t, prod[t]],
      });
    }
  }
  return out;
}

function combustionEntries() {
  const out = [];
  for (let t = 1; t < MAT_COUNT; t++) {
    if (MATERIALS[t].hidden || IGNITION_TEMP[t] === Infinity) continue;
    if (EXPLODE_POWER[t] > 0) {
      out.push({
        title: `${name(t)} detonates`,
        detail: `Goes off above ${deg(IGNITION_TEMP[t])}, blast radius ${EXPLODE_RADIUS[t]}. ` +
          'A blast dumps heat as well as force, so what it sets off next is up to the scene.',
        mats: [t],
      });
    } else {
      out.push({
        title: `${name(t)} burns`,
        detail: `Catches above ${deg(IGNITION_TEMP[t])}, burns in place for about ` +
          `${BURN_FUEL[t]} frames, leaves ${product(ASH_PRODUCT[t])}.`,
        mats: [t, ASH_PRODUCT[t]],
      });
    }
  }
  return out;
}

function electricalEntries() {
  const out = [];
  for (let t = 1; t < MAT_COUNT; t++) {
    if (MATERIALS[t].hidden || (!CONDUCTS[t] && !EMITS_CHARGE[t])) continue;
    const bits = [];
    if (EMITS_CHARGE[t]) bits.push('Supplies current continuously.');
    if (CONDUCTS[t]) {
      // 255 charge losing CHARGE_DECAY per hop is the run length you actually get
      const hops = CHARGE_DECAY[t] > 0 ? Math.floor(255 / CHARGE_DECAY[t]) : Infinity;
      bits.push(hops === Infinity
        ? 'Carries current with no loss.'
        : `Carries current about ${hops} cells before it dies out.`);
    }
    if (RESISTANCE[t] > 0.05) bits.push('High resistance: heats up under load and eventually burns through.');
    else if (RESISTANCE[t] > 0) bits.push('Low resistance: warms slightly under load.');
    out.push({ title: `${name(t)} conducts`, detail: bits.join(' '), mats: [t] });
  }
  return out;
}

function growthEntries() {
  return growers().map((t) => ({
    title: `${name(t)} grows`,
    detail: 'Creeps into empty space while there is water in reach, until its own ' +
      'budget runs out — so a single strand cannot green the whole world.',
    mats: [t],
  }));
}

/**
 * The only hand-written section. These are prompts, not facts — everything
 * factual is generated above so it cannot go stale.
 */
const TRY_THIS = [
  ['Quench lava with water',
    'Pour water onto lava. It turns to stone and throws off steam — and there is no rule for it. ' +
    'Lava is simply hot, water simply boils, stone is simply what cold lava is.'],
  ['Melt sand into glass',
    'Drop sand onto lava. It fuses to molten glass, and molten glass cooling below 1000°C sets as glass.'],
  ['Light a fire and let it go out',
    'Wood burns in place, staying wood-shaped while it glows, then collapses into ash when its fuel runs out.'],
  ['Boil a tank of brine dry',
    'Drop a spark into brine. The current heats it, the heat boils it away, and the salt it was ' +
    'carrying is left behind as a solid.'],
  ['Zap a pool of water',
    'A spark is the only thing that supplies current. Drop one into water and the charge spreads ' +
    'across the whole body at once — watch it in the Charge view.'],
  ['Set off gunpowder without a flame',
    'Run a spark next to a gunpowder pile. Current passing nearby nudges it over its own ignition ' +
    'point, so it goes off through the ordinary rules rather than a special case.'],
  ['Turn the room into an oven',
    'Push room temperature past 300°C and walk away. Wood catches on its own, ice never survives, ' +
    'and water boils off the moment you place it.'],
  ['Throw a thermite charge into water',
    'Thermite is the one thing that keeps burning submerged, and the only thing hot enough to melt ' +
    'straight through metal.'],
  ['Use the heat gun on ice',
    'Ice to water to steam, and the steam condenses back into rain when it cools against the ceiling.'],
];

/* -------------------------------- assembly -------------------------------- */

export function buildCodex() {
  return [
    {
      group: 'Try this',
      generated: false,
      entries: TRY_THIS.map(([title, detail]) => ({ title, detail, mats: [] })),
    },
    { group: 'Reactions', generated: true, entries: reactionEntries() },
    { group: 'Heat', generated: true, entries: transitionEntries() },
    { group: 'Fire and blast', generated: true, entries: combustionEntries() },
    { group: 'Current', generated: true, entries: electricalEntries() },
    { group: 'Growth', generated: true, entries: growthEntries() },
  ];
}

/**
 * Counts taken straight from the tables, for the parity self-check. If the codex
 * ever stops covering everything the simulation does, this is what catches it.
 */
export function expectedCounts() {
  let transitions = 0, combustion = 0, electrical = 0;
  for (let t = 1; t < MAT_COUNT; t++) {
    if (MATERIALS[t].hidden) continue;
    if (MELT_POINT[t] < Infinity) transitions++;
    if (BOIL_POINT[t] < Infinity) transitions++;
    if (FREEZE_POINT[t] > -Infinity) transitions++;
    if (CONDENSE_POINT[t] > -Infinity) transitions++;
    if (IGNITION_TEMP[t] < Infinity) combustion++;
    if (CONDUCTS[t] || EMITS_CHARGE[t]) electrical++;
  }
  return {
    Reactions: reactionRows().length,
    Heat: transitions,
    'Fire and blast': combustion,
    Current: electrical,
    Growth: growers().length,
  };
}
