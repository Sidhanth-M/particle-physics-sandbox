/**
 * Assert-based self-checks for the pieces that are easy to break silently:
 * density layering, chunk sleeping, and corrosion.
 *
 * Run by loading the page with ?selfcheck. Results go to the console and are
 * mirrored onto `window.__selfcheck` so a headless driver can read them.
 */

import {
  G, initGrid, setCell, clearGrid, clearCell as clearCellAt,
  awakeChunkCount, F_BURNING, AMBIENT,
} from './grid.js';
import { stepSim } from './sim.js';
import { heatStats } from './heat.js';
import { reactionStats, reactionKeys, reactionCount } from './reactions.js';
import { particleStats, clearParticles, particleCount, spawnParticle } from './particles.js';
import { explode, blastStats } from './explosions.js';
import {
  tool, TOOL_LIST, TOOL_BY_ID, toolDown, toolDrag, toolUp, floodFill, wellRadius,
} from './tools.js';
import {
  selectTool, selectMaterial, setBrush, toolReach, setDrawer, drawerOpen, setInspector,
  setCodex, codexOpen,
} from './ui.js';
import { STAMPS, stampSpan } from './stamps.js';
import { buildCodex, expectedCounts } from './codex.js';
import {
  encodeScene, decodeScene, toBase64, fromBase64, pushUndo, undo, redo,
  undoDepth, clearHistory, PRESETS, applyPreset,
} from './scene.js';
import {
  SAND, WATER, OIL, WALL, ACID, EMPTY, WOOD, ASH, FIRE, SMOKE,
  ICE, STEAM, LAVA, STONE, METAL, GLASS,
} from './materials.js';
import * as M from './materials.js';

const results = [];

/**
 * Every check starts from an empty particle pool.
 *
 * Free particles live OUTSIDE the grid and are stamped into `mat` at the end of
 * each tick, so `initGrid` + `clearGrid` does not remove them — debris left by an
 * earlier check keeps raining into the next one's scene. That silently
 * destabilised the fuse check: stone falling across the wire row smothers the arc
 * that consumes the run after the first cell blows. Measured 2 failures in 6 with
 * debris present, 0 in 6 without.
 *
 * 38 of the checks never cleared the pool. One line here beats 38 call sites and
 * the 39th that would forget.
 */
function check(name, fn) {
  try {
    clearParticles();
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: String(e && e.message || e) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run(steps) {
  for (let i = 0; i < steps; i++) stepSim();
}

/** Mean row index of a material. Lower = sitting higher up. */
function meanRow(t) {
  let sum = 0, n = 0;
  for (let y = 0; y < G.h; y++) {
    for (let x = 0; x < G.w; x++) if (G.mat[y * G.w + x] === t) { sum += y; n++; }
  }
  return n === 0 ? NaN : sum / n;
}

function countOf(t) {
  let n = 0;
  for (let i = 0; i < G.n; i++) if (G.mat[i] === t) n++;
  return n;
}

/**
 * A narrow walled tank. Liquids need to be many rows deep for layering to mean
 * anything — spread thin across an open floor they are one cell deep and every
 * ordering looks the same.
 */
function tank(w, h, left, right, floor) {
  initGrid(w, h);
  clearGrid();
  for (let x = left - 1; x <= right; x++) setCell(floor * w + x, WALL);
  for (let y = 0; y <= floor; y++) { setCell(y * w + left - 1, WALL); setCell(y * w + right, WALL); }
}

function fill(y0, y1, x0, x1, t) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setCell(y * G.w + x, t);
}

export function runSelfChecks() {
  const saved = { w: G.w, h: G.h, mat: G.mat && G.mat.slice() };

  check('lighter liquid floats above heavier liquid', () => {
    const L = 36, R = 60, FLOOR = 90;
    tank(96, 96, L, R, FLOOR);
    fill(FLOOR - 8, FLOOR, L, R, OIL);          // oil poured in first...
    fill(FLOOR - 20, FLOOR - 12, L, R, WATER);  // ...water dumped on top of it
    run(1200);
    const oil = countOf(OIL), water = countOf(WATER);
    assert(oil === 192 && water === 192, `liquids must be conserved (oil ${oil}, water ${water})`);
    const mo = meanRow(OIL), mw = meanRow(WATER);
    assert(mo < mw, `oil should end up above water (mean rows: oil ${mo.toFixed(1)}, water ${mw.toFixed(1)})`);
  });

  check('denser powder sinks through water', () => {
    initGrid(64, 64);
    for (let x = 0; x < 64; x++) setCell(63 * 64 + x, WALL);
    for (let y = 40; y < 63; y++) for (let x = 0; x < 64; x++) setCell(y * 64 + x, WATER);
    for (let x = 28; x < 36; x++) setCell(5 * 64 + x, SAND);
    run(500);
    let lowestSand = -1;
    for (let y = 0; y < 63; y++) {
      for (let x = 0; x < 64; x++) if (G.mat[y * 64 + x] === SAND) lowestSand = y;
    }
    assert(lowestSand >= 60, `sand should reach the floor through water, got row ${lowestSand}`);
  });

  check('idle chunks go to sleep', () => {
    initGrid(128, 128);
    clearGrid();
    for (let x = 0; x < 128; x++) setCell(127 * 128 + x, WALL);
    for (let y = 100; y < 127; y++) for (let x = 10; x < 40; x++) setCell(y * 128 + x, SAND);
    run(300);
    const awake = awakeChunkCount();
    assert(awake < G.cn,
      `a settled scene should not keep every chunk awake (${awake}/${G.cn})`);
  });

  check('acid eats sand faster than it eats wall', () => {
    const survivors = (target) => {
      initGrid(64, 64);
      clearGrid();
      for (let y = 30; y < 50; y++) for (let x = 20; x < 44; x++) setCell(y * 64 + x, target);
      for (let x = 20; x < 44; x++) setCell(29 * 64 + x, ACID);
      run(200);
      let n = 0;
      for (let i = 0; i < G.n; i++) if (G.mat[i] === target) n++;
      return n;
    };
    const sandLeft = survivors(SAND);
    const wallLeft = survivors(WALL);
    assert(sandLeft < wallLeft,
      `wall should outlast sand under acid (sand ${sandLeft}, wall ${wallLeft})`);
  });

  check('empty grid stays empty', () => {
    initGrid(64, 64);
    clearGrid();
    run(50);
    for (let i = 0; i < G.n; i++) assert(G.mat[i] === EMPTY, 'nothing should appear from nowhere');
  });

  /* ------------------------------ phase 3 ------------------------------ */

  /**
   * Static audit of the material table. Catches two silent-failure classes
   * that no runtime test would surface unless you happened to try the exact
   * pairing: a transition nothing in the world is hot enough to trigger, and a
   * forward/reverse threshold pair with no gap between them (flip-flop).
   */
  check('every phase transition is reachable and hysteresis-safe', () => {
    let hottest = -Infinity;
    for (let t = 0; t < M.MAT_COUNT; t++) {
      if (M.SPAWN_TEMP[t] !== M.INHERIT_TEMP) hottest = Math.max(hottest, M.SPAWN_TEMP[t]);
    }
    const name = (t) => M.MATERIALS[t].name;

    for (let t = 0; t < M.MAT_COUNT; t++) {
      // reachability: something in the roster has to be able to get this hot
      if (M.MELT_POINT[t] < Infinity) {
        assert(M.MELT_POINT[t] <= hottest,
          `${name(t)} melts at ${M.MELT_POINT[t]}C but nothing spawns hotter than ${hottest}C`);
      }
      if (M.BOIL_POINT[t] < Infinity) {
        assert(M.BOIL_POINT[t] <= hottest,
          `${name(t)} boils at ${M.BOIL_POINT[t]}C but nothing spawns hotter than ${hottest}C`);
      }

      // hysteresis: the product must not immediately transition back
      if (M.MELT_POINT[t] < Infinity) {
        const p = M.MELT_PRODUCT[t];
        assert(M.FREEZE_POINT[p] < M.MELT_POINT[t],
          `${name(t)}->${name(p)} at ${M.MELT_POINT[t]}C flip-flops: ${name(p)} refreezes at ${M.FREEZE_POINT[p]}C`);
      }
      if (M.FREEZE_POINT[t] > -Infinity) {
        const p = M.FREEZE_PRODUCT[t];
        assert(M.MELT_POINT[p] > M.FREEZE_POINT[t],
          `${name(t)}->${name(p)} at ${M.FREEZE_POINT[t]}C flip-flops: ${name(p)} remelts at ${M.MELT_POINT[p]}C`);
      }
      if (M.BOIL_POINT[t] < Infinity) {
        const p = M.BOIL_PRODUCT[t];
        assert(M.CONDENSE_POINT[p] < M.BOIL_POINT[t],
          `${name(t)}->${name(p)} at ${M.BOIL_POINT[t]}C flip-flops: ${name(p)} recondenses at ${M.CONDENSE_POINT[p]}C`);
      }
      if (M.CONDENSE_POINT[t] > -Infinity) {
        const p = M.CONDENSE_PRODUCT[t];
        assert(M.BOIL_POINT[p] > M.CONDENSE_POINT[t],
          `${name(t)}->${name(p)} at ${M.CONDENSE_POINT[t]}C flip-flops: ${name(p)} reboils at ${M.BOIL_POINT[p]}C`);
      }

      // A self-heating material must not be able to re-melt its own frozen
      // form, or the boundary between the two thrashes forever and the hot
      // phase eats the cold one.
      if (M.SELF_HEAT[t] > 0 && M.FREEZE_POINT[t] > -Infinity) {
        const solid = M.FREEZE_PRODUCT[t];
        assert(M.MELT_POINT[solid] > M.SELF_HEAT_CAP[t],
          `${name(t)} self-heats to ${M.SELF_HEAT_CAP[t]}C but its frozen form ` +
          `${name(solid)} melts at ${M.MELT_POINT[solid]}C — it would re-melt its own output`);
      }

      // a burning material has to hold well above its own ignition point or
      // the fire front stalls instead of spreading
      if (M.BURN_FUEL[t] > 0) {
        assert(M.BURN_HEAT[t] > 0 && M.IGNITION_TEMP[t] < Infinity,
          `${name(t)} has fuel but no burnHeat/ignitionTemp`);
      }

      // a charge with no ignition point can never go off
      if (M.EXPLODE_POWER[t] > 0) {
        assert(M.IGNITION_TEMP[t] < Infinity && M.EXPLODE_RADIUS[t] > 0,
          `${name(t)} has explodePower but no ignitionTemp/explodeRadius`);
      }
    }
  });

  check('molten glass cools into solid glass', () => {
    // The sand->glass path is a phase 4 contact reaction (see the note on
    // SAND.meltPoint); what phase 3 owns is that the molten phase solidifies.
    const L = 20, R = 44, FLOOR = 60;
    tank(64, 64, L, R, FLOOR);
    fill(FLOOR - 12, FLOOR, L, R, M.MOLTEN_GLASS);
    for (let k = 0; k < 4000 && countOf(GLASS) === 0; k++) stepSim();
    assert(countOf(GLASS) > 0, 'molten glass should cool and freeze into glass');
    assert(countOf(M.MOLTEN_GLASS) < 288, 'not all of it should still be molten');
  });

  check('ice melts to water, boils to steam, then condenses back', () => {
    const L = 20, R = 44, FLOOR = 60;
    tank(64, 64, L, R, FLOOR);
    fill(FLOOR - 10, FLOOR, L, R, ICE);
    const seen = { water: false, steam: false, condensed: false };

    // heat the tank walls hard, so the change is driven purely by conduction
    for (let k = 0; k < 1500; k++) {
      for (let y = 0; y <= FLOOR; y++) {
        G.temp[y * G.w + L - 1] = 1200;
        G.temp[y * G.w + R] = 1200;
        G.temp[FLOOR * G.w + ((L + R) >> 1)] = 1200;
      }
      stepSim();
      if (countOf(WATER) > 0) seen.water = true;
      if (seen.water && countOf(STEAM) > 0) seen.steam = true;
      if (seen.steam) break;
    }
    assert(seen.water, 'ice should melt to water');
    assert(seen.steam, 'water should boil to steam');

    // stop heating; the steam must cool and condense back to water
    for (let k = 0; k < 4000 && !seen.condensed; k++) {
      stepSim();
      if (countOf(STEAM) === 0 && countOf(WATER) > 0) seen.condensed = true;
    }
    assert(seen.condensed, 'steam should condense back to water once it cools');
  });

  check('lava quenched by water becomes stone and steam', () => {
    const L = 20, R = 44, FLOOR = 60;
    tank(64, 64, L, R, FLOOR);
    fill(FLOOR - 6, FLOOR, L, R, LAVA);
    fill(FLOOR - 30, FLOOR - 20, L, R, WATER);
    let sawSteam = false;
    for (let k = 0; k < 2500; k++) {
      stepSim();
      if (countOf(STEAM) > 0) sawSteam = true;
      if (sawSteam && countOf(STONE) > 0) break;
    }
    assert(sawSteam, 'water hitting lava should flash to steam');
    assert(countOf(STONE) > 0, 'lava losing its heat to water should freeze to stone');
    // and no explicit lava+water rule exists anywhere: this is pure heat transfer
  });

  check('wood burns in place and leaves ash behind', () => {
    initGrid(64, 64);
    clearGrid();
    const W = 64;
    for (let x = 0; x < W; x++) setCell(63 * W + x, WALL);
    fill(40, 62, 20, 44, WOOD);
    for (let y = 40; y < 62; y++) G.temp[y * W + 20] = 900;   // light one edge

    let burnedInPlace = false;
    for (let k = 0; k < 400; k++) {
      stepSim();
      // a burning cell must still BE wood, not have been swapped for a fire cell
      for (let i = 0; i < G.n; i++) {
        if ((G.flags[i] & F_BURNING) && G.mat[i] === WOOD) { burnedInPlace = true; break; }
      }
      if (burnedInPlace) break;
    }
    assert(burnedInPlace, 'wood should burn while still being wood');

    for (let k = 0; k < 3000 && countOf(WOOD) > 0; k++) stepSim();
    assert(countOf(WOOD) === 0, 'the fire should consume the whole block');
    assert(countOf(ASH) > 0, 'burnt wood should leave ash');
    run(600);
    assert(countOf(FIRE) === 0, 'the fire must go out once the fuel is gone');
  });

  /* ------------------------------ phase 4 ------------------------------ */

  check('three liquids stack in density order: oil, water, brine', () => {
    const L = 30, R = 66, FLOOR = 90;
    tank(96, 96, L, R, FLOOR);
    fill(FLOOR - 8, FLOOR, L, R, OIL);            // deliberately poured in the
    fill(FLOOR - 18, FLOOR - 10, L, R, M.BRINE);  // wrong order, so settling
    fill(FLOOR - 28, FLOOR - 20, L, R, WATER);    // has to do the work
    run(2500);
    const mo = meanRow(OIL), mw = meanRow(WATER), mb = meanRow(M.BRINE);
    assert(mo < mw, `oil should float above water (oil ${mo.toFixed(1)}, water ${mw.toFixed(1)})`);
    assert(mw < mb, `brine should sink below water (water ${mw.toFixed(1)}, brine ${mb.toFixed(1)})`);
  });

  /**
   * Drives EVERY row in the reaction table rather than a hand-picked few, so a
   * row added later is covered without touching this test.
   */
  check('every reaction row actually fires', () => {
    const failures = [];
    for (const key of reactionKeys()) {
      const low = (key / M.MAT_COUNT) | 0, high = key % M.MAT_COUNT;
      const L = 26, R = 38, FLOOR = 56;
      tank(64, 64, L, R, FLOOR);
      // the two blocks must START touching: a pair of static solids has no
      // way to close a gap between them
      fill(FLOOR - 8, FLOOR, L, R, high);
      fill(FLOOR - 16, FLOOR - 8, L, R, low);
      reactionStats.fired = 0;
      for (let k = 0; k < 2000 && reactionStats.fired === 0; k++) stepSim();
      if (reactionStats.fired === 0) {
        failures.push(`${M.MATERIALS[low].name} + ${M.MATERIALS[high].name}`);
      }
    }
    assert(failures.length === 0,
      `${failures.length}/${reactionCount()} reaction rows never fired: ${failures.join(', ')}`);
  });

  check('plants grow from seed and stop at their budget', () => {
    const L = 26, R = 38, FLOOR = 56;
    tank(64, 64, L, R, FLOOR);
    fill(FLOOR - 1, FLOOR, L, R, WATER);
    fill(FLOOR - 3, FLOOR - 2, L, R, M.SEED);
    let grew = false;
    for (let k = 0; k < 4000; k++) {
      stepSim();
      if (countOf(M.PLANT) > 0) { grew = true; break; }
    }
    assert(grew, 'seed in water should germinate into a plant');
    run(6000);
    const plants = countOf(M.PLANT);
    assert(plants < 400, `plant growth must be bounded, got ${plants} cells`);
  });

  check('an explosion throws debris that lands back in the grid', () => {
    initGrid(96, 96);
    clearGrid();
    clearParticles();
    const W = 96;
    for (let x = 0; x < W; x++) setCell(95 * W + x, WALL);
    fill(60, 94, 20, 76, M.SAND);          // a bank of loose material to throw
    particleStats.spawned = 0;
    particleStats.landed = 0;

    explode(48, 80, 14, 40);
    assert(particleStats.spawned > 0, 'the blast should eject debris as particles');

    // debris must be airborne (outside the grid) before it settles
    let sawAirborne = false;
    for (let k = 0; k < 400; k++) {
      stepSim();
      if (particleCount() > 0) sawAirborne = true;
      if (particleCount() === 0 && sawAirborne) break;
    }
    assert(sawAirborne, 'debris should spend time in flight');
    assert(particleStats.landed > 0,
      `debris must re-integrate into the grid (spawned ${particleStats.spawned}, landed ${particleStats.landed})`);
    assert(particleCount() === 0, 'no particle should still be in flight after settling');
  });

  check('particles never overwrite existing material', () => {
    initGrid(64, 64);
    clearGrid();
    clearParticles();
    fill(30, 62, 0, 64, M.STONE);          // solid block: nowhere free to land
    const before = countOf(M.STONE);
    for (let k = 0; k < 60; k++) spawnParticle(32, 10, 0, 1.4, M.SAND);
    run(300);
    assert(countOf(M.STONE) === before,
      `stone was overwritten by landing debris (${before} -> ${countOf(M.STONE)})`);
  });

  check('a gunpowder chain detonation terminates', () => {
    initGrid(96, 96);
    clearGrid();
    clearParticles();
    const W = 96;
    for (let x = 0; x < W; x++) setCell(95 * W + x, WALL);
    fill(50, 94, 10, 86, M.GUNPOWDER);     // a large charge that must cook off
    blastStats.total = 0;
    G.temp[70 * W + 48] = 900;             // light it in the middle
    run(1500);
    assert(blastStats.total > 1, 'the charge should chain-detonate');
    assert(countOf(M.GUNPOWDER) === 0, 'the whole charge should go off');
    for (let i = 0; i < G.n; i++) {
      assert(Number.isFinite(G.temp[i]), 'a blast produced a non-finite temperature');
    }
    run(2000);
    assert(countOf(FIRE) === 0, 'blast fires should burn out');
  });

  check('thermite burns underwater and melts through metal', () => {
    const L = 24, R = 42, FLOOR = 60;
    tank(64, 64, L, R, FLOOR);
    fill(FLOOR - 4, FLOOR, L, R, METAL);
    fill(FLOOR - 9, FLOOR - 5, L, R, M.THERMITE);
    fill(FLOOR - 30, FLOOR - 10, L, R, WATER);   // fully submerged
    for (let x = L; x < R; x++) G.temp[(FLOOR - 6) * G.w + x] = 900;
    let melted = false;
    for (let k = 0; k < 4000; k++) {
      stepSim();
      if (countOf(M.MOLTEN_METAL) > 0) { melted = true; break; }
    }
    assert(melted, 'thermite should keep burning under water and melt the metal below it');
  });

  /* ------------------------------ phase 5 ------------------------------ */

  check('current runs the length of a wire and stops when the source is cut', () => {
    initGrid(96, 96);
    clearGrid();
    const W = 96, y = 40;
    setCell(y * W + 10, M.BATTERY);
    for (let x = 11; x < 80; x++) setCell(y * W + x, M.WIRE);
    let reachedEnd = false;
    for (let k = 0; k < 400 && !reachedEnd; k++) {
      stepSim();
      if (G.charge[y * W + 79] > 0) reachedEnd = true;
    }
    assert(reachedEnd, 'charge should travel the whole 69-cell wire run');

    // cut the supply: the wire must go dead rather than staying live forever
    clearCellAt(y * W + 10);
    run(300);
    let live = 0;
    for (let x = 11; x < 80; x++) if (G.charge[y * W + x] > 0) live++;
    assert(live === 0, `${live} wire cells still carry current after the battery was removed`);
  });

  check('current arcs across a gap between two wire runs', () => {
    initGrid(96, 96);
    clearGrid();
    const W = 96, y = 40;
    setCell(y * W + 10, M.BATTERY);
    for (let x = 11; x < 40; x++) setCell(y * W + x, M.WIRE);
    // two-cell air gap, then the far run
    for (let x = 42; x < 70; x++) setCell(y * W + x, M.WIRE);
    let jumped = false;
    for (let k = 0; k < 600 && !jumped; k++) {
      stepSim();
      if (G.charge[y * W + 42] > 0) jumped = true;
    }
    assert(jumped, 'current should arc the gap and energise the far wire run');
  });

  check('current detonates gunpowder', () => {
    initGrid(96, 96);
    clearGrid();
    clearParticles();
    const W = 96;
    for (let x = 0; x < W; x++) setCell(95 * W + x, WALL);
    // The charge is a POWDER: left as a free pile it slumps out from under the
    // wire before the current arrives. Bin it, and drop the wire in from above.
    for (let y = 86; y < 95; y++) { setCell(y * W + 39, WALL); setCell(y * W + 56, WALL); }
    fill(88, 95, 40, 56, M.GUNPOWDER);
    setCell(78 * W + 48, M.BATTERY);
    for (let y = 79; y <= 87; y++) setCell(y * W + 48, M.WIRE);
    blastStats.total = 0;
    for (let k = 0; k < 900 && blastStats.total === 0; k++) stepSim();
    assert(blastStats.total > 0, 'current reaching gunpowder should set it off');
  });

  check('a water body carries current out to its decay limit', () => {
    const L = 20, R = 70, FLOOR = 80;
    tank(96, 96, L, R, FLOOR);
    fill(FLOOR - 12, FLOOR, L, R, WATER);
    run(400);                                     // let it settle flat
    setCell((FLOOR - 1) * G.w + L, M.BATTERY);    // electrode at one end
    run(30);

    let reach = -1;
    for (let i = 0; i < G.n; i++) {
      if (G.mat[i] !== WATER || G.charge[i] === 0) continue;
      const x = i % G.w;
      if (x > reach) reach = x;
    }

    assert(reach >= L + 30,
      `current should cross the body, not just the cells touching the electrode — reached ${reach - L} cells`);

    /*
     * ...and it must STOP where the model says it must. Charge starts at 255 and
     * loses CHARGE_DECAY per hop, so water carries it about 42 cells and no
     * further. Measured reach is 62, i.e. exactly 42 from the electrode.
     *
     * The original version of this check probed the far wall at 48 hops, which
     * conduction can never reach. It passed only when resistive heating boiled
     * the body hard enough to slosh a charged cell that far — chance, and it
     * duly failed about one run in three. Asserting the bound as well as the
     * spread is what turns this into a measurement.
     */
    const hops = Math.floor(255 / M.CHARGE_DECAY[WATER]);
    assert(reach <= L + hops + 2,
      `charge reached ${reach - L} cells, past the ${hops}-hop limit its decay allows`);
  });

  check('a loaded fuse burns out while a metal bus survives', () => {
    initGrid(96, 96);
    clearGrid();
    const W = 96;
    // Same current through each: the difference is the material's resistance,
    // not its cross-section. Charge here does not divide across parallel paths,
    // so geometry cannot be the variable — a thicker run of the same material
    // would actually run hotter, having no internal gradient to shed heat down.
    setCell(20 * W + 5, M.BATTERY);
    for (let x = 6; x < 60; x++) setCell(20 * W + x, M.FUSE);
    setCell(60 * W + 5, M.BATTERY);
    for (let x = 6; x < 60; x++) setCell(60 * W + x, METAL);

    // A fuse blows at ONE point: the first cell to melt breaks the run, so
    // everything downstream de-energises and cools. Whole-run destruction is
    // the wrong thing to assert — a break plus a dead far end is the signal.
    let blown = false;
    for (let k = 0; k < 4000 && !blown; k++) {
      stepSim();
      for (let x = 6; x < 60; x++) if (G.mat[20 * W + x] !== M.FUSE) { blown = true; break; }
    }
    assert(blown, 'a fuse under sustained load should burn through somewhere');

    // Deliberately NOT asserting the far end goes dead: a one-cell gap is
    // within arc reach, so current jumps it and keeps eating the run. That is
    // the arcing rule working, and it means fuse wire is progressively consumed
    // under load rather than failing once.
    run(600);
    let gone = 0;
    for (let x = 6; x < 60; x++) if (G.mat[20 * W + x] !== M.FUSE) gone++;
    assert(gone > 1, `the arc across the break should keep consuming the fuse, ${gone} cells gone`);

    let metalLeft = 0;
    for (let x = 6; x < 60; x++) if (G.mat[60 * W + x] === METAL) metalLeft++;
    assert(metalLeft === 54, `the low-resistance metal bus should be untouched, ${metalLeft}/54 left`);
    assert(G.charge[60 * W + 59] > 0, 'the metal bus should still be carrying current');
  });

  /* ------------------------------ phase 10 ------------------------------ */

  check('wire carries a battery indefinitely, where a fuse blows', () => {
    // The bug this phase exists to fix: wire had resistance 0.2 against a source
    // that pins charge at 255, so resistive heating added 51 C/frame into a
    // 1000 C melting point — wire touching a battery blew in about 20 frames.
    initGrid(96, 96);
    clearGrid();
    const W = 96, Y = 20;
    setCell(Y * W + 5, M.BATTERY);
    for (let x = 6; x < 60; x++) setCell(Y * W + x, M.WIRE);

    run(3000);

    let left = 0, peak = -Infinity;
    for (let x = 6; x < 60; x++) {
      if (G.mat[Y * W + x] === M.WIRE) left++;
      peak = Math.max(peak, G.temp[Y * W + x]);
    }
    assert(left === 54, `wire must survive its own supply: ${left}/54 left after 3000 frames`);
    assert(peak < M.MELT_POINT[M.WIRE],
      `wire settled at ${peak.toFixed(0)}C against a ${M.MELT_POINT[M.WIRE]}C melting point`);
    assert(G.charge[Y * W + 59] > 0, 'the far end of the wire should still be energised');
  });

  check('an open switch cuts the circuit and closing it restores current', () => {
    initGrid(96, 96);
    clearGrid();
    const W = 96, Y = 20, FAR = 60;
    setCell(Y * W + 5, M.BATTERY);
    for (let x = 6; x < FAR; x++) setCell(Y * W + x, M.WIRE);
    // six cells wide, deliberately beyond arc reach — a one-cell switch would be
    // jumped by the arc rule, which is correct behaviour but untestable as a switch
    for (let x = 30; x < 36; x++) setCell(Y * W + x, M.SWITCH);

    run(200);
    assert(G.charge[Y * W + FAR - 1] > 0, 'a freshly placed switch is closed and should pass current');

    for (let x = 30; x < 36; x++) G.aux[Y * W + x] = 1;
    run(400);
    assert(G.charge[Y * W + FAR - 1] === 0,
      `an open switch should cut the far end, still reads ${G.charge[Y * W + FAR - 1]}`);
    assert(G.charge[Y * W + 10] > 0, 'the supply side of an open switch should stay live');
    for (let x = 30; x < 36; x++) {
      assert(G.shade[Y * W + x] >= 2, 'an open switch should show its open shade');
    }

    for (let x = 30; x < 36; x++) G.aux[Y * W + x] = 0;
    run(200);
    assert(G.charge[Y * W + FAR - 1] > 0, 'closing the switch should restore current');
  });

  check('a lamp lights only while it is carrying current', () => {
    initGrid(96, 96);
    clearGrid();
    const W = 96, Y = 20, LI = Y * W + 40;
    setCell(Y * W + 5, M.BATTERY);
    for (let x = 6; x < 40; x++) setCell(Y * W + x, M.WIRE);
    setCell(LI, M.LAMP);

    const glowOf = (shade) => M.PALETTE_RGBA[((M.LAMP * 4) + shade) * 4 + 3];

    run(200);
    const lit = G.shade[LI];
    assert(lit >= 2, `a powered lamp should switch to a lit shade, got ${lit}`);
    assert(glowOf(lit) > 200, `the lit shade must actually glow, alpha ${glowOf(lit)}`);

    clearCellAt(Y * W + 5);                    // pull the battery
    run(400);
    const dark = G.shade[LI];
    assert(dark < 2, `an unpowered lamp should go dark, shade ${dark}`);
    assert(glowOf(dark) === 0, `the dark shade must not glow, alpha ${glowOf(dark)}`);
  });

  check('a fan moves fluid only while it is powered', () => {
    /*
     * A ONE-CELL-WIDE vertical shaft with the fan at the bottom facing up.
     *
     * The control here is GRAVITY, which is deterministic, and the shaft's width
     * removes horizontal dispersion entirely — measured 20/20 repeats at exactly
     * 73.5 unpowered and 61.5 powered, zero variance either way.
     *
     * Three earlier designs measured nothing, each for a different reason, and
     * they are worth not repeating: fluid placed outside FAN_REACH is never
     * touched, so the test read pure drift; a WATER probe conducts, so the
     * battery boiled it rather than the fan blowing it; and a liquid in a wide
     * sealed tube returns to hydrostatic equilibrium whatever the fan does. The
     * horizontal version that survived all three still failed intermittently,
     * because comparing two samples of a random walk is not a measurement.
     */
    const meanY = (powered) => {
      initGrid(96, 96);
      clearGrid();
      const W = 96, X = 40;
      for (let y = 20; y <= 80; y++) { setCell(y * W + X - 1, WALL); setCell(y * W + X + 1, WALL); }
      setCell(80 * W + X, M.FAN);
      G.aux[80 * W + X] = 0;                             // facing up
      if (powered) setCell(81 * W + X, M.BATTERY);
      for (let y = 40; y < 48; y++) setCell(y * W + X, OIL);   // oil does not conduct

      run(30);
      let sum = 0, n = 0;
      for (let y = 20; y <= 80; y++) if (G.mat[y * W + X] === OIL) { sum += y; n++; }
      return n === 0 ? NaN : sum / n;
    };

    const fell = meanY(false), held = meanY(true);
    assert(held < fell - 6,
      `a powered fan should hold fluid up against gravity: mean row ${fell.toFixed(1)} unpowered, ` +
      `${held.toFixed(1)} powered`);
  });

  check('clicking a placed component adjusts it instead of repainting', () => {
    initGrid(96, 96);
    clearGrid();
    tool.symX = false; tool.symY = false;
    selectTool('paint');
    setBrush(1);

    selectMaterial(M.SWITCH);
    const i = 40 * 96 + 40;
    toolDown(40, 40, false); toolUp(40, 40);
    assert(G.mat[i] === M.SWITCH, 'the first click on empty space should place the switch');
    assert(G.aux[i] === 0, 'a newly placed switch must default to CLOSED, or new circuits are dead');
    toolDown(40, 40, false); toolUp(40, 40);
    assert(G.mat[i] === M.SWITCH && G.aux[i] === 1, 'clicking it again should open it');
    toolDown(40, 40, false); toolUp(40, 40);
    assert(G.aux[i] === 0, 'and again should close it');

    selectMaterial(M.FAN);
    const j = 50 * 96 + 50;
    toolDown(50, 50, false); toolUp(50, 50);
    assert(G.mat[j] === M.FAN && G.aux[j] === 0, 'a placed fan should start facing up');
    toolDown(50, 50, false); toolUp(50, 50);
    assert(G.aux[j] === 1, 'clicking a placed fan should rotate it');

    // a DIFFERENT material must still paint straight over it
    selectMaterial(SAND);
    toolDown(50, 50, false); toolUp(50, 50);
    assert(G.mat[j] === M.FAN, 'sand should not overwrite packed terrain, fan included');
    setBrush(3);
  });

  /* ------------------------------ phase 6 ------------------------------ */

  /**
   * Drives EVERY tool at the extremes of brush size with both mirrors on.
   * Tools are the most combinatorial surface in the app, so this walks the
   * product rather than spot-checking a few.
   */
  check('every tool runs at every brush size with symmetry on', () => {
    const broken = [];
    for (const def of TOOL_LIST) {
      for (const size of [1, 8, 16]) {
        for (const sym of [false, true]) {
          initGrid(96, 96);
          clearGrid();
          clearParticles();
          fill(60, 90, 10, 86, SAND);
          fill(30, 50, 10, 86, WATER);
          for (let x = 0; x < 96; x++) setCell(95 * 96 + x, WALL);

          tool.id = def.id;
          tool.size = size;
          tool.shape = sym ? 'square' : 'circle';
          tool.symX = sym; tool.symY = sym;
          tool.material = def.id === 'emitter' ? WATER : M.LAVA;

          try {
            toolDown(40, 40, false);
            toolDrag(40, 40, 55, 52, false);
            toolDrag(55, 52, 62, 70, false);
            toolUp(62, 70);
            toolDown(30, 30, true);            // right-button pass too
            toolDrag(30, 30, 44, 44, true);
            toolUp(44, 44);
            run(40);
          } catch (err) {
            broken.push(`${def.id} size=${size} sym=${sym}: ${err.message}`);
            continue;
          }

          for (let i = 0; i < G.n; i++) {
            if (!Number.isFinite(G.temp[i])) {
              broken.push(`${def.id} size=${size} sym=${sym}: produced a non-finite temperature`);
              break;
            }
            if (G.mat[i] >= M.MAT_COUNT) {
              broken.push(`${def.id} size=${size} sym=${sym}: wrote material id ${G.mat[i]}`);
              break;
            }
          }
        }
      }
    }
    assert(broken.length === 0, broken.join(' | '));
  });

  check('each tool has the effect it claims, and the eyedropper has none', () => {
    // Compared immediately after the stroke with NO simulation steps in
    // between: running frames would let sand settle and every tool would look
    // like it had changed the grid. The heat guns are judged on temperature,
    // because they deliberately never change material.
    const failures = [];
    for (const def of TOOL_LIST) {
      initGrid(96, 96);
      clearGrid();
      clearParticles();
      // The stroke has to cross empty space AND loose material: placement tools
      // refuse to overwrite packed terrain, and wind only moves fluids.
      fill(40, 56, 10, 86, WATER);
      fill(60, 90, 10, 86, SAND);
      for (let x = 0; x < 96; x++) setCell(95 * 96 + x, WALL);

      tool.id = def.id; tool.size = 6; tool.shape = 'circle';
      tool.symX = false; tool.symY = false; tool.material = M.LAVA;

      const matBefore = G.mat.slice();
      const tempBefore = G.temp.slice();
      // One segment deliberately ends JUST ABOVE the water surface. The
      // gravity well pulls material toward its centre, so it can only move
      // anything when that centre sits in empty space beside material — buried
      // inside a mass, every inward target is already occupied. It also only
      // acts where a drag segment ends, not along the segment.
      toolDown(30, 30, false);
      toolDrag(30, 30, 40, 37, false);
      toolDrag(40, 37, 40, 42, false);
      toolDrag(40, 42, 48, 50, false);
      toolDrag(48, 50, 60, 70, false);
      toolUp(60, 70);

      let matChanged = false, tempChanged = false;
      for (let i = 0; i < G.n; i++) {
        if (G.mat[i] !== matBefore[i]) matChanged = true;
        if (G.temp[i] !== tempBefore[i]) tempChanged = true;
        if (matChanged && tempChanged) break;
      }

      if (def.id === 'pick') {
        if (matChanged) failures.push('eyedropper must not modify the grid');
        // probe a cell we know holds sand: the stroke above starts on empty
        // space, where picking nothing is the correct behaviour
        toolDown(48, 70, false);
        if (tool.material !== SAND) {
          failures.push(`eyedropper should have picked sand, got ${M.MATERIALS[tool.material].name}`);
        }
      } else if (def.id === 'heat' || def.id === 'cool') {
        if (!tempChanged) failures.push(`${def.id} should change temperature`);
        if (matChanged) failures.push(`${def.id} should not change material directly`);
      } else if (!matChanged) {
        failures.push(`${def.id} left the grid untouched`);
      }
    }
    assert(failures.length === 0, failures.join(' | '));
  });

  check('symmetry mirrors edits across both axes', () => {
    initGrid(96, 96);
    clearGrid();
    tool.id = 'paint'; tool.size = 3; tool.shape = 'circle';
    tool.symX = true; tool.symY = true; tool.material = WALL; tool.scatter = 1;
    toolDown(20, 30, false);

    const at = (x, y) => G.mat[y * 96 + x] === WALL;
    assert(at(20, 30), 'the original stroke should be painted');
    assert(at(95 - 20, 30), 'the stroke should be mirrored across X');
    assert(at(20, 95 - 30), 'the stroke should be mirrored across Y');
    assert(at(95 - 20, 95 - 30), 'the stroke should be mirrored across both axes');
  });

  check('flood fill stays inside its region', () => {
    initGrid(96, 96);
    clearGrid();
    // a sealed box of wall with sand inside; the fill must not escape it
    for (let x = 20; x <= 60; x++) { setCell(20 * 96 + x, WALL); setCell(60 * 96 + x, WALL); }
    for (let y = 20; y <= 60; y++) { setCell(y * 96 + 20, WALL); setCell(y * 96 + 60, WALL); }
    fill(21, 60, 21, 60, SAND);
    const outsideBefore = countOf(EMPTY);
    floodFill(40, 40, M.LAVA);
    assert(countOf(SAND) === 0, 'the whole enclosed region should be filled');
    assert(countOf(EMPTY) === outsideBefore, 'the fill must not leak outside the sealed box');
  });

  check('an emitter keeps producing its material', () => {
    initGrid(96, 96);
    clearGrid();
    for (let x = 0; x < 96; x++) setCell(95 * 96 + x, WALL);
    tool.id = 'emitter'; tool.size = 1; tool.symX = false; tool.symY = false;
    tool.material = WATER;
    toolDown(48, 20, false);
    assert(G.mat[20 * 96 + 48] === M.EMITTER, 'the emitter tool should place an emitter cell');
    run(400);
    assert(countOf(WATER) > 20, `the emitter should have poured water, got ${countOf(WATER)} cells`);
    assert(G.mat[20 * 96 + 48] === M.EMITTER, 'the emitter itself should survive');
  });

  /* ------------------------------ phase 7 ------------------------------ */

  /** Build something messy enough that a lazy codec would get it wrong. */
  function complexScene() {
    initGrid(128, 96);
    clearGrid();
    clearParticles();
    const W = 128;
    for (let x = 0; x < W; x++) setCell(95 * W + x, WALL);
    fill(70, 95, 4, 60, SAND);
    fill(50, 70, 10, 50, WATER);
    fill(30, 44, 60, 100, OIL);
    fill(80, 95, 70, 110, M.LAVA);
    fill(20, 28, 20, 40, ICE);
    fill(60, 78, 100, 124, WOOD);
    fill(10, 18, 70, 90, M.GUNPOWDER);
    setCell(40 * W + 100, M.BATTERY);
    for (let x = 101; x < 120; x++) setCell(40 * W + x, M.WIRE);
    run(150);                       // let it develop fire, steam, charge, flags
    for (let i = 0; i < G.n; i += 37) G.charge[i] = (i * 13) % 256;
    G.temp[5 * W + 5] = 1234.5;     // an awkward float that must survive exactly
  }

  function snapshotState() {
    return {
      w: G.w, h: G.h,
      mat: G.mat.slice(), shade: G.shade.slice(), aux: G.aux.slice(),
      flags: G.flags.slice(), charge: G.charge.slice(), temp: G.temp.slice(),
    };
  }

  /**
   * `mat`, `aux`, `flags` and `charge` must come back exactly. Three fields are
   * deliberately lossy, because storing them exactly made a shareable link
   * impossible — and none of them can move a pixel:
   *   - material temperature: quantised to 0.25C, EXCEPT cells above the
   *     shader's 500C blackbody threshold, which keep their exact float
   *   - air temperature: quantised to 4C (an empty cell always draws as the
   *     EMPTY palette entry, so its temperature has no visual effect at all)
   *   - shade: kept only for non-empty cells, for the same reason
   */
  const TEMP_TOLERANCE_MATERIAL = 0.125;   // half a 0.25C step
  const TEMP_TOLERANCE_AIR = 2;            // half a 4C step

  function diffState(a, b) {
    if (a.w !== b.w || a.h !== b.h) return `size ${a.w}x${a.h} -> ${b.w}x${b.h}`;
    for (const key of ['mat', 'aux', 'flags', 'charge']) {
      for (let i = 0; i < a[key].length; i++) {
        if (a[key][i] !== b[key][i]) return `${key}[${i}] ${a[key][i]} -> ${b[key][i]}`;
      }
    }
    for (let i = 0; i < a.temp.length; i++) {
      const tol = a.mat[i] === EMPTY ? TEMP_TOLERANCE_AIR : TEMP_TOLERANCE_MATERIAL;
      if (Math.abs(a.temp[i] - b.temp[i]) > tol) {
        return `temp[${i}] ${a.temp[i]} -> ${b.temp[i]} (tolerance ${tol})`;
      }
    }
    // anything the shader would draw a blackbody glow for must be exact
    for (let i = 0; i < a.temp.length; i++) {
      if (a.mat[i] !== EMPTY && a.temp[i] >= 500 && a.temp[i] !== b.temp[i]) {
        return `hot temp[${i}] must be exact: ${a.temp[i]} -> ${b.temp[i]}`;
      }
    }
    for (let i = 0; i < a.shade.length; i++) {
      if (a.mat[i] !== EMPTY && a.shade[i] !== b.shade[i]) {
        return `shade[${i}] ${a.shade[i]} -> ${b.shade[i]} (material ${a.mat[i]})`;
      }
    }
    return null;
  }

  check('a scene survives an encode/decode round trip', () => {
    complexScene();
    const before = snapshotState();
    const bytes = encodeScene();
    // scribble over live state so a decode that silently no-ops cannot pass
    G.mat.fill(WALL); G.temp.fill(-1); G.charge.fill(9);
    decodeScene(bytes);
    const diff = diffState(before, snapshotState());
    assert(diff === null, `state changed across the round trip: ${diff}`);
  });

  check('the encoded scene is small enough to live in a URL', () => {
    complexScene();
    const bytes = encodeScene();
    assert(bytes.length < 200000,
      `${bytes.length} bytes before compression is too large for a link`);
  });

  check('undo and redo restore exact prior states', () => {
    complexScene();
    const original = snapshotState();
    pushUndo();
    fill(0, 20, 0, 128, M.THERMITE);      // a big destructive edit
    const edited = snapshotState();
    assert(diffState(original, edited) !== null, 'the edit should have changed something');

    assert(undo(), 'undo should report success');
    assert(diffState(original, snapshotState()) === null, 'undo did not restore the original state');

    assert(redo(), 'redo should report success');
    assert(diffState(edited, snapshotState()) === null, 'redo did not restore the edited state');
  });

  check('undo history is bounded', () => {
    initGrid(64, 64);
    clearGrid();
    clearHistory();
    for (let k = 0; k < 40; k++) { pushUndo(); setCell(k, WALL); }
    assert(undoDepth() <= 20, `undo history grew to ${undoDepth()} entries`);
  });

  check('every preset builds something and stays stable', () => {
    for (const p of PRESETS) {
      initGrid(200, 125);
      clearGrid();
      assert(applyPreset(p.id), `preset ${p.id} should apply`);
      let filled = 0;
      for (let i = 0; i < G.n; i++) if (G.mat[i] !== EMPTY) filled++;
      assert(filled > 100, `preset ${p.id} built almost nothing (${filled} cells)`);
      run(300);
      for (let i = 0; i < G.n; i++) {
        assert(Number.isFinite(G.temp[i]), `preset ${p.id} produced a non-finite temperature`);
      }
    }
  });

  check('base64 survives every byte value', () => {
    const raw = new Uint8Array(256 * 4);
    for (let i = 0; i < raw.length; i++) raw[i] = i & 255;
    const back = fromBase64(toBase64(raw));
    assert(back.length === raw.length, `length changed ${raw.length} -> ${back.length}`);
    for (let i = 0; i < raw.length; i++) {
      assert(back[i] === raw[i], `byte ${i} changed ${raw[i]} -> ${back[i]}`);
    }
  });

  check('10k-frame soak stays finite, bounded and non-oscillating', () => {
    const L = 8, R = 56, FLOOR = 60;
    tank(64, 64, L, R, FLOOR);
    fill(FLOOR - 8, FLOOR, L, R, LAVA);
    fill(FLOOR - 22, FLOOR - 16, L, 30, WATER);
    fill(FLOOR - 22, FLOOR - 16, 32, R, ICE);
    fill(FLOOR - 40, FLOOR - 30, L, 26, WOOD);
    fill(FLOOR - 40, FLOOR - 34, 34, R, METAL);

    /**
     * Oscillation is measured by counting REAL phase changes at their source
     * (heatStats), not by diffing cell materials between frames: a falling
     * stone swapping with lava, or water flowing into an empty cell, both look
     * exactly like a transition at that cell index. A settling system does its
     * transitions early and then goes quiet; a flip-flopping one never does.
     */
    heatStats.transitions = 0;
    let earlyTransitions = 0;

    let hottest = -Infinity, coldest = Infinity;
    for (let k = 0; k < 10000; k++) {
      stepSim();
      if (k === 999) earlyTransitions = heatStats.transitions;
      if ((k & 255) === 0) {
        for (let i = 0; i < G.n; i++) {
          const t = G.temp[i];
          assert(Number.isFinite(t), `temperature went non-finite at frame ${k}`);
          if (t > hottest) hottest = t;
          if (t < coldest) coldest = t;
        }
      }
    }

    assert(hottest <= 6000, `peak temperature ran away to ${hottest.toFixed(0)}C`);
    assert(coldest >= -273, `temperature fell below absolute zero: ${coldest.toFixed(0)}C`);
    const lateTransitions = heatStats.transitions - earlyTransitions;   // frames 1000..9999
    assert(lateTransitions < earlyTransitions,
      `phase changes are not dying down: ${earlyTransitions} in the first 1k frames, ` +
      `${lateTransitions} in the next 9k — the system is flip-flopping, not settling`);

    // and it must actually settle: everything back near room temperature
    let over = 0;
    for (let i = 0; i < G.n; i++) if (G.temp[i] > AMBIENT + 200) over++;
    assert(over < G.n * 0.02,
      `${over} cells still hot after 10k frames — the system never sheds its energy`);
  });

  /* ------------------------- panel + affordance ------------------------- */

  check('every scrollable panel contains its own overscroll', () => {
    const panels = [...document.querySelectorAll('.panel-scroll')];
    assert(panels.length >= 2, `expected the rail and material list to scroll, found ${panels.length}`);
    for (const p of panels) {
      const v = getComputedStyle(p).overscrollBehaviorY;
      assert(v === 'contain' || v === 'none',
        `${p.id || p.className} has overscroll-behavior-y: ${v} — reaching the end of ` +
        `this list will scroll the whole page instead`);
    }
  });

  check('the brush ring is drawn at the armed tool\'s true reach', () => {
    const canvas = document.getElementById('sim');
    const ring = document.getElementById('brushRing');
    const r = canvas.getBoundingClientRect();
    assert(r.width > 0, 'canvas has no layout box, cannot verify the ring');
    const cell = r.width / G.w;
    const wrong = [];

    for (const def of TOOL_LIST) {
      for (const size of [1, 8, 16]) {
        selectTool(def.id);
        setBrush(size);
        canvas.dispatchEvent(new PointerEvent('pointermove', {
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true,
        }));
        const want = Math.max((def.reach(tool) * 2 + 1) * cell, 6);
        const got = parseFloat(ring.style.width);
        if (Math.abs(got - want) > 0.5) {
          wrong.push(`${def.id} size=${size}: ring ${got.toFixed(1)}px, reach says ${want.toFixed(1)}px`);
        }
      }
    }
    assert(wrong.length === 0, wrong.join('; '));

    // and a field tool must be visually distinct from a placement tool
    selectTool('well');
    assert(ring.classList.contains('field'), 'gravity well should draw the dashed field ring');
    selectTool('paint');
    assert(!ring.classList.contains('field'), 'paint should draw the solid placement ring');
  });

  check('the well reaches far beyond the brush footprint', () => {
    setBrush(8);
    assert(wellRadius(tool) > tool.size - 1,
      `well radius ${wellRadius(tool)} is no wider than the brush footprint ${tool.size - 1}`);
  });

  check('picking a material arms Paint only when the tool ignores it', () => {
    const chip = document.querySelector('#matGroups button[data-mat]');
    assert(chip, 'no material chips in the panel');

    // the reported trap: Gravity Well armed, clicking materials, nothing paints
    selectTool('well');
    chip.click();
    assert(tool.id === 'paint',
      `clicking a material while a field tool is armed should arm Paint, got ${tool.id}`);

    // ...but a tool that genuinely uses the material must be left alone
    for (const id of ['line', 'rect', 'fillrect', 'flood', 'emitter']) {
      selectTool(id);
      chip.click();
      assert(tool.id === id, `${id} uses the material and must not be swapped for Paint`);
    }
    selectTool('paint');
  });

  check('the canvas badge names the armed tool', () => {
    const name = document.getElementById('toolBadgeName');
    for (const def of TOOL_LIST) {
      selectTool(def.id);
      assert(name.textContent === def.name,
        `badge reads "${name.textContent}" while ${def.id} is armed`);
    }
    selectTool('paint');
  });

  check('the inspector survives the grid shrinking under the cursor', () => {
    // A resize reallocates the grid while curX/curY still describe the old one.
    // Reached for real by dragging the window narrower with the cursor at the
    // right-hand edge of the canvas.
    initGrid(64, 64);
    clearGrid();
    setInspector(400, 250, true);          // coords from a wider grid
    assert(document.getElementById('inspMat').textContent === '—',
      'an out-of-bounds cursor should read as nothing, not throw');
    setInspector(10, 10, true);
    assert(document.getElementById('inspXY').textContent === '10,10',
      'an in-bounds cursor should still report normally');
  });

  check('the scene drawer opens and closes', () => {
    setDrawer(false);
    assert(!drawerOpen(), 'drawer should start closed');
    setDrawer(true);
    assert(drawerOpen(), 'drawer did not open');
    const d = document.getElementById('sceneDrawer');
    assert(!d.classList.contains('hidden'), 'open drawer is still hidden');

    // "not hidden" is not the same as "readable". The first version used a
    // Tailwind arbitrary-colour opacity modifier that never generated, so the
    // drawer opened SEE-THROUGH and double-exposed the panel underneath it.
    const bg = getComputedStyle(d).backgroundColor;
    const alpha = bg.startsWith('rgba') ? parseFloat(bg.split(',')[3]) : 1;
    assert(alpha >= 0.98,
      `the drawer must be opaque or the panel behind it shows through — got ${bg}`);

    setDrawer(false);
    assert(!drawerOpen(), 'drawer did not close');
  });

  check('the gravity well drags material in from its outer radius', () => {
    // Stepped WITHOUT the sim so gravity cannot be mistaken for the well's pull.
    // The centre sits in open air: buried in a mass, every inward target is
    // already occupied and the well legitimately does nothing.
    initGrid(96, 96);
    clearGrid();
    clearParticles();
    tool.symX = false; tool.symY = false;
    selectTool('well');
    setBrush(8);
    const CX = 48, CY = 48;
    const R = wellRadius(tool);
    assert(R >= 18, `expected a wide well at size 8, got ${R}`);
    fill(44, 53, 60, 71, SAND);

    const meanDist = () => {
      let sum = 0, n = 0;
      for (let y = 0; y < G.h; y++) {
        for (let x = 0; x < G.w; x++) {
          if (G.mat[y * G.w + x] !== SAND) continue;
          sum += Math.hypot(x - CX, y - CY); n++;
        }
      }
      return n === 0 ? NaN : sum / n;
    };

    const before = meanDist();
    const grains = countOf(SAND);
    for (let f = 0; f < 20; f++) toolDrag(CX, CY, CX, CY, false);
    const after = meanDist();

    assert(countOf(SAND) === grains,
      `the well must move sand, not create or destroy it (${grains} -> ${countOf(SAND)})`);
    assert(before - after > 3,
      `well barely moved anything: mean distance ${before.toFixed(1)} -> ${after.toFixed(1)} ` +
      `cells over 20 frames inside a radius of ${R}`);

    // right-drag has to push the other way
    const mid = meanDist();
    for (let f = 0; f < 20; f++) toolDrag(CX, CY, CX, CY, true);
    assert(meanDist() > mid,
      `right-drag should repel: ${mid.toFixed(1)} -> ${meanDist().toFixed(1)}`);
    selectTool('paint');
    setBrush(3);
  });

  /* ------------------------------- stamps ------------------------------- */

  check('every stamp draws a connected, multi-shaded shape at every size', () => {
    const bad = [];
    for (const [name, def] of Object.entries(STAMPS)) {
      for (const size of [2, 8, 16]) {
        initGrid(128, 128);
        clearGrid();
        const cells = [];
        def.draw(64, 90, size, (x, y, mat, shade) => {
          if (x < 0 || x >= 128 || y < 0 || y >= 128) return;
          const i = y * 128 + x;
          if (G.mat[i] !== EMPTY) return;
          setCell(i, mat);
          G.shade[i] = shade & 3;
          cells.push(i);
        });

        if (cells.length < 3) { bad.push(`${name}@${size}: drew only ${cells.length} cells`); continue; }

        // a blob of one flat colour is exactly what this phase exists to replace
        const shades = new Set(cells.map(i => G.shade[i]));
        if (shades.size < 2) bad.push(`${name}@${size}: single shade ${[...shades]} — reads as a blob`);

        // horizontal extent must fit the declared span, or drag spacing smears
        let lo = 1e9, hi = -1e9;
        for (const i of cells) { const x = i % 128; if (x < lo) lo = x; if (x > hi) hi = x; }
        const extent = hi - lo + 1, span = def.span(size);
        if (extent > span) bad.push(`${name}@${size}: ${extent} cells wide but span claims ${span}`);

        // one object, not scattered debris: flood the placed cells 8-connected
        const set = new Set(cells);
        const stack = [cells[0]], seen = new Set([cells[0]]);
        while (stack.length) {
          const i = stack.pop(), x = i % 128, y = (i / 128) | 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= 128 || ny < 0 || ny >= 128) continue;
              const j = ny * 128 + nx;
              if (!set.has(j) || seen.has(j)) continue;
              seen.add(j); stack.push(j);
            }
          }
        }
        if (seen.size !== set.size) {
          bad.push(`${name}@${size}: ${set.size - seen.size} of ${set.size} cells detached from the shape`);
        }
      }
    }
    assert(bad.length === 0, bad.join('; '));
  });

  check('the stamp materials are wired to their generators', () => {
    const want = { [M.PLANT]: 'sprig', [M.FUNGUS]: 'mushroom', [M.BATTERY]: 'battery' };
    for (const [id, name] of Object.entries(want)) {
      assert(M.STAMP[id] === name, `material ${id} should stamp "${name}", got ${M.STAMP[id]}`);
    }
    // ...and the brush must actually route through them
    initGrid(96, 96);
    clearGrid();
    tool.symX = false; tool.symY = false;
    selectTool('paint');
    setBrush(8);
    selectMaterial(M.FUNGUS);
    toolDown(48, 70, false);
    toolUp(48, 70);
    const shades = new Set();
    let n = 0;
    for (let i = 0; i < G.n; i++) if (G.mat[i] === M.FUNGUS) { n++; shades.add(G.shade[i]); }
    assert(n > 20, `painting fungus at size 8 should place a mushroom, got ${n} cells`);
    assert(shades.size >= 2, 'the painted mushroom has one flat shade — the stamp was bypassed');
  });

  check('a stamp cannot carve through packed terrain', () => {
    initGrid(96, 96);
    clearGrid();
    fill(30, 80, 20, 76, WALL);
    const before = G.mat.slice();
    tool.symX = false; tool.symY = false;
    selectTool('paint');
    setBrush(10);
    selectMaterial(M.PLANT);
    toolDown(48, 70, false);
    toolUp(48, 70);
    let changed = 0;
    for (let i = 0; i < G.n; i++) if (G.mat[i] !== before[i]) changed++;
    assert(changed === 0, `${changed} wall cells were overwritten by a stamp`);
  });

  check('dragging places spaced objects rather than a smear', () => {
    initGrid(128, 96);
    clearGrid();
    tool.symX = false; tool.symY = false;
    selectTool('paint');
    setBrush(4);
    selectMaterial(M.FUNGUS);

    const X0 = 20, X1 = 100, Y = 60;
    toolDown(X0, Y, false);
    for (let x = X0 + 1; x <= X1; x++) toolDrag(x - 1, Y, x, Y, false);   // one cell per frame
    toolUp(X1, Y);

    // count runs of stem along the click row: distinct runs mean distinct objects
    let runs = 0, gap = 0, inRun = false;
    for (let x = X0 - 4; x <= X1 + 8; x++) {
      const solid = G.mat[Y * 128 + x] === M.FUNGUS;
      if (solid && !inRun) runs++;
      if (!solid && inRun) gap++;
      inRun = solid;
    }
    const span = stampSpan('mushroom', 4);
    const expected = Math.floor((X1 - X0) / span);
    assert(runs >= expected - 1 && runs <= expected + 2,
      `a ${X1 - X0}-cell drag at span ${span} should leave about ${expected} objects, counted ${runs}`);
    assert(gap >= runs - 1, `objects are fused together: ${runs} runs but only ${gap} gaps`);
  });

  check('the forest has a canopy above every trunk', () => {
    initGrid(400, 250);
    clearGrid();
    clearParticles();
    applyPreset('forest');

    const W = G.w, H = G.h;
    const topWood = new Int32Array(W).fill(-1);
    const topPlant = new Int32Array(W).fill(-1);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const t = G.mat[y * W + x];
        if (t === WOOD && topWood[x] < 0) topWood[x] = y;
        if (t === M.PLANT && topPlant[x] < 0) topPlant[x] = y;
      }
    }

    // group contiguous wood columns into trunks
    const trunks = [];
    for (let x = 0; x < W; x++) {
      if (topWood[x] < 0) continue;
      if (trunks.length && x - trunks[trunks.length - 1].x1 <= 1) trunks[trunks.length - 1].x1 = x;
      else trunks.push({ x0: x, x1: x });
    }
    assert(trunks.length >= 6, `expected a forest, found ${trunks.length} trunks`);

    const bare = [];
    for (const t of trunks) {
      let crown = 1e9;
      for (let x = t.x0; x <= t.x1; x++) crown = Math.min(crown, topWood[x]);
      let leafy = false;
      for (let x = Math.max(0, t.x0 - 3); x <= Math.min(W - 1, t.x1 + 3); x++) {
        if (topPlant[x] >= 0 && topPlant[x] < crown) { leafy = true; break; }
      }
      if (!leafy) bare.push(`${t.x0}-${t.x1} (crown row ${crown})`);
    }
    assert(bare.length === 0, `trunks with no canopy above them: ${bare.join(', ')}`);
  });

  check('the circuit board preset actually lights its lamp', () => {
    /*
     * A preset that quietly fails is worse than no preset. The first version of
     * this one placed the lamp 305 cells from the battery, against a charge that
     * starts at 255 and loses 1 per hop of wire — it could never have lit, and
     * nothing in the suite would have said so.
     */
    initGrid(400, 250);
    clearGrid();
    applyPreset('circuit');
    run(120);

    let lit = 0, dark = 0, sw = 0;
    for (let i = 0; i < G.n; i++) {
      if (G.mat[i] === M.LAMP) { if (G.shade[i] >= 2) lit++; else dark++; }
      if (G.mat[i] === M.SWITCH) sw++;
    }
    assert(lit > 0, `the preset's lamp never lit (${dark} dark cells) — the rail cannot reach it`);
    assert(sw > 0, 'the preset should ship a switch to cut the light with');

    // opening the switch must put it out again
    for (let i = 0; i < G.n; i++) if (G.mat[i] === M.SWITCH) G.aux[i] = 1;
    run(200);
    let stillLit = 0;
    for (let i = 0; i < G.n; i++) if (G.mat[i] === M.LAMP && G.shade[i] >= 2) stillLit++;
    assert(stillLit === 0, `${stillLit} lamp cells stayed lit after the switch was opened`);
  });

  check('the forest fire actually crosses the forest', () => {
    // The preset is named for a spreading fire. Bare trunks gave it nothing to
    // spread THROUGH — one trunk burned and the front stalled. Measured with
    // canopies: the front reaches x=76 by frame 1500 and 184 by frame 6000 on a
    // 480-wide grid, so this asserts the early, cheap part of that curve.
    initGrid(400, 250);
    clearGrid();
    applyPreset('forest');

    const ignitedBelow = 40;              // the preset's hot patch, in grid cells
    const front = () => {
      let x = -1;
      for (let i = 0; i < G.n; i++) {
        if (G.mat[i] !== FIRE && !(G.flags[i] & F_BURNING)) continue;
        const cx = i % G.w;
        if (cx > x) x = cx;
      }
      return x;
    };

    run(1500);
    const f = front();
    assert(f > ignitedBelow,
      `the fire front is still at x=${f}, inside the ignition patch (<=${ignitedBelow}) — it is not spreading`);

    let ash = 0;
    for (let i = 0; i < G.n; i++) if (G.mat[i] === ASH) ash++;
    assert(ash > 200, `a spreading fire should leave ash behind, found ${ash} cells`);
  });

  /* ------------------------------- codex ------------------------------- */

  check('the guide documents everything the tables actually do', () => {
    /*
     * The anti-staleness assertion, and the reason the guide is generated rather
     * than written: a material or reaction added later must show up in it with no
     * edit to codex.js. Counting rendered entries against counts derived
     * independently from the tables is what makes that a guarantee instead of a
     * hope.
     */
    const want = expectedCounts();
    const got = {};
    for (const s of buildCodex()) got[s.group] = s.entries.length;

    for (const [group, n] of Object.entries(want)) {
      assert(got[group] === n,
        `the guide's "${group}" section has ${got[group]} entries but the tables define ${n}`);
      assert(n > 0, `"${group}" derived a count of zero — the generator is reading nothing`);
    }

    // and the rendered DOM must match, not just the data
    const rows = document.querySelectorAll('#codexBody [data-q]');
    const total = Object.values(got).reduce((a, b) => a + b, 0);
    assert(rows.length === total,
      `${total} entries were generated but ${rows.length} reached the page`);
  });

  check('every guide entry names real materials and reads as prose', () => {
    const bad = [];
    for (const s of buildCodex()) {
      for (const e of s.entries) {
        if (!e.title || !e.detail) bad.push(`${s.group}: an entry is missing title or detail`);
        if (/undefined|NaN|\[object/.test(e.title + e.detail)) {
          bad.push(`${s.group}: "${e.title}" — ${e.detail}`);
        }
        for (const m of e.mats) {
          if (m < 0 || m >= M.MAT_COUNT) bad.push(`${s.group}: "${e.title}" references material ${m}`);
        }
      }
    }
    assert(bad.length === 0, bad.slice(0, 4).join(' | '));
  });

  check('the guide opens, searches and closes', () => {
    setCodex(false);
    assert(!codexOpen(), 'the guide should start closed');
    setCodex(true);
    assert(codexOpen(), 'the guide did not open');

    const search = document.getElementById('codexSearch');
    const visible = () => document.querySelectorAll('#codexBody [data-q]:not(.hidden)').length;
    const all = visible();
    assert(all > 20, `expected a populated guide, ${all} entries visible`);

    search.value = 'lava';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const hits = visible();
    assert(hits > 0 && hits < all, `searching "lava" gave ${hits} of ${all} entries`);
    for (const row of document.querySelectorAll('#codexBody [data-q]:not(.hidden)')) {
      assert(row.dataset.q.includes('lava'), `"${row.dataset.q.slice(0, 40)}" does not match the query`);
    }

    search.value = 'zzzznothing';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    assert(visible() === 0, 'a query matching nothing should hide every entry');

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    assert(visible() === all, 'clearing the search should restore every entry');

    setCodex(false);
    assert(!codexOpen(), 'the guide did not close');
  });

  // restore whatever the page was showing
  if (saved.mat) {
    initGrid(saved.w, saved.h);
    G.mat.set(saved.mat);
  }

  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    if (r.ok) console.log(`PASS  ${r.name}`);
    else console.error(`FAIL  ${r.name}: ${r.error}`);
  }
  console.log(`${results.length - failed.length}/${results.length} self-checks passed`);
  window.__selfcheck = { results, passed: failed.length === 0 };
  return failed.length === 0;
}
