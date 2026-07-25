/**
 * Material descriptor table.
 *
 * Materials are DATA, not code. Movement dispatches on `category` and thermal
 * behaviour dispatches on threshold fields, so adding a material is a row in
 * this table rather than a new branch anywhere else.
 */

export const CAT = {
  NONE:   0,  // empty space
  POWDER: 1,  // falls, slides down diagonals (sand, dirt, ash, snow)
  LIQUID: 2,  // falls, spreads sideways, layers by density (water, oil, lava)
  GAS:    3,  // rises, disperses (smoke, steam)
  SOLID:  4,  // static (wall, wood, glass, metal, ice)
  RIGID:  5,  // falls straight down, never slides (stone rubble)
  ENERGY: 6,  // massless, propagating, decaying (fire)
  EMITTER: 7, // static source that keeps pouring its `aux` material
};

export const CAT_NAME = ['', 'Powder', 'Liquid', 'Gas', 'Solid', 'Rigid', 'Energy', 'Source'];

export const EMPTY = 0, SAND = 1, DIRT = 2, STONE = 3, WALL = 4, WOOD = 5,
             WATER = 6, OIL = 7, ACID = 8, SMOKE = 9, FIRE = 10, ASH = 11,
             ICE = 12, SNOW = 13, STEAM = 14, LAVA = 15, GLASS = 16,
             MOLTEN_GLASS = 17, METAL = 18, MOLTEN_METAL = 19, OBSIDIAN = 20,
             SALT = 21, BRINE = 22, GUNPOWDER = 23, NITRO = 24, THERMITE = 25,
             GASOLINE = 26, ACID_VAPOR = 27, SEED = 28, PLANT = 29, VINE = 30,
             FUNGUS = 31, SPARK = 32, PLASMA = 33, EMITTER = 34;

/** Sentinel for "this material has no inherent spawn temperature". */
export const INHERIT_TEMP = -9999;

const DEFAULTS = {
  name: '?',
  category: CAT.SOLID,
  /** Only relative order matters: higher sinks through lower. */
  density: 1000,
  /** LIQUID/GAS: how many cells it will scan sideways looking for a gap. */
  dispersion: 0,
  /** POWDER: 0 = slides to a shallow pile, 1 = stacks in vertical columns. */
  friction: 0,
  /** How aggressively this material eats its neighbours (0 = inert). */
  corrosive: 0,
  /** 0 = dissolves instantly, 1 = immune. */
  corrosionResist: 1,
  /** ENERGY/GAS: initial lifetime in frames, [min, max]. [0,0] = never decays. */
  life: [0, 0],
  /**
   * ENERGY: water snuffs this out on contact. True for flame, false for
   * electrical discharge — a spark in water is not put out, it CONDUCTS, which
   * is the whole reason charge can cross a pool.
   */
  dousedByWater: false,
  /**
   * ENERGY: drifts upward into empty space, because hot gas rises. True for
   * flame. A discharge is not a gas and must NOT drift: a spark left buoyant
   * floats off within a frame or two of being placed, which measured as 15
   * failures in 16 at setting off gunpowder it was sitting directly on.
   */
  buoyant: false,
  /** 0..1 glow strength. Drives the bloom pass; rides in the palette's alpha. */
  emissive: 0,
  /**
   * Optional per-shade glow, overriding `emissive`. This is what lets a lamp be
   * dark when unpowered and blazing when lit without a second material or a
   * shader branch: charge picks the shade, the shade carries the glow.
   */
  emissiveShades: null,
  /** Hidden from the material picker (EMPTY). */
  hidden: false,
  /**
   * Name of a generator in `stamps.js`. A material with one is placed as a SHAPE
   * scaled to the brush size rather than a scatter of cells — a mushroom instead
   * of a purple blob. Null means the ordinary brush.
   */
  stamp: null,
  colors: ['#ff00ff', '#ff00ff', '#ff00ff', '#ff00ff'],

  /* ------------------------------ thermal ------------------------------ */
  /** 0..1 effective thermal diffusivity. Metal conducts, wood insulates. */
  conductivity: 0.2,
  /** Temperature a freshly placed cell gets, or INHERIT_TEMP to keep the cell's. */
  spawnTemp: INHERIT_TEMP,
  /**
   * Phase thresholds. Melt/boil fire on the way up, freeze/condense on the way
   * down. The forward and reverse thresholds of any pair MUST leave a gap, or
   * the cell flip-flops between states every frame — see the hysteresis note
   * on each pair below.
   */
  meltPoint: Infinity, meltProduct: EMPTY,
  boilPoint: Infinity, boilProduct: EMPTY,
  freezePoint: -Infinity, freezeProduct: EMPTY,
  condensePoint: -Infinity, condenseProduct: EMPTY,

  /**
   * Self-heating: degrees/frame this cell injects into itself while below
   * `selfHeatCap`. This is what makes a material a heat SOURCE rather than a
   * heat STORE — without it, lava poured on cold sand just gives up its heat
   * and freezes before anything melts. Capped, so it can never run away.
   */
  selfHeat: 0,
  selfHeatCap: 0,

  /* ---------------------------- electrical ---------------------------- */
  /** Carries charge to its neighbours. */
  conducts: false,
  /** Holds full charge every frame — a source rather than a path. */
  emitsCharge: false,
  /** Charge lost per cell hop. High values make a material a poor conductor. */
  chargeDecay: 8,
  /** Degrees C per unit of charge per frame. This is what melts thin wire. */
  resistance: 0,

  /* ------------------------------ blast ------------------------------ */
  /** How well a cell survives a blast. Compared against power/distance. */
  blastResist: 1,
  /** Non-zero makes this material detonate instead of burn when it ignites. */
  explodeRadius: 0,
  explodePower: 0,
  /** Keeps burning in contact with water (thermite). */
  waterproofBurn: false,

  /* ---------------------------- combustion ---------------------------- */
  /** Temperature at which this catches fire. */
  ignitionTemp: Infinity,
  /** Degrees C this cell injects into itself each frame while burning. */
  burnHeat: 0,
  /** Frames of fuel. When it runs out the cell becomes `ashProduct`. */
  burnFuel: 0,
  ashProduct: EMPTY,
  /** Legacy spread probability, still used when painting fire directly. */
  flammability: 0,
};

const m = (o) => ({ ...DEFAULTS, ...o });

export const MATERIALS = [
  m({ name: 'Empty', category: CAT.NONE, density: 0, hidden: true,
      conductivity: 0.05,                                   // air: conducts a little
      colors: ['#07080c', '#07080c', '#07080c', '#07080c'] }),

  m({ name: 'Sand', category: CAT.POWDER, density: 1600, friction: 0,
      corrosionResist: 0.2, conductivity: 0.15,
      // Reachable only by molten-metal-class heat. Measured: a low-conductivity
      // cell touching a 1300C source equilibrates near 650C, because diffusion
      // pulls each cell toward its NEIGHBOUR AVERAGE, not toward the source.
      // Fusing sand with lava is therefore a contact reaction, not a phase
      // transition, and lives in the phase 4 reaction table.
      meltPoint: 1200, meltProduct: MOLTEN_GLASS,          // molten glass freezes at 1000: 200 gap
      colors: ['#f4d35e', '#e9c46a', '#d9b34c', '#f7dd83'] }),

  m({ name: 'Dirt', category: CAT.POWDER, density: 1400, friction: 0.7,
      corrosionResist: 0.15, conductivity: 0.12,
      colors: ['#6b4f2a', '#5c4322', '#7a5c33', '#543d1f'] }),

  m({ name: 'Stone', category: CAT.RIGID, density: 2600,
      corrosionResist: 0.75, conductivity: 0.25, blastResist: 4,
      // MUST stay above lava's selfHeatCap (1300). Below it, lava re-melts the
      // stone it just froze into, and every lava/stone boundary thrashes.
      meltPoint: 1400, meltProduct: LAVA,                   // lava freezes at 950: 450 gap
      colors: ['#7d8794', '#6d7683', '#8a94a1', '#636b77'] }),

  m({ name: 'Wall', category: CAT.SOLID, density: 3000,
      corrosionResist: 0.85, conductivity: 0.2, blastResist: 9,
      colors: ['#5b6270', '#4a505c', '#6a7282', '#414652'] }),

  m({ name: 'Wood', category: CAT.SOLID, density: 700,
      corrosionResist: 0.3, conductivity: 0.14, flammability: 0.12, blastResist: 2,
      // burnHeat is degrees/frame injected against conduction + ambient bleed.
      // It has to hold the cell WELL above ignitionTemp or the fire front
      // stalls: the equilibrium sits near 640C here, versus 300C to ignite.
      ignitionTemp: 300, burnHeat: 30, burnFuel: 220, ashProduct: ASH,
      colors: ['#9b6a36', '#85562a', '#6f461f', '#a87a45'] }),

  m({ name: 'Water', category: CAT.LIQUID, density: 1000, dispersion: 5,
      conductivity: 0.4,
      conducts: true, chargeDecay: 6, resistance: 0.004,    // poor conductor
      boilPoint: 100, boilProduct: STEAM,                   // steam condenses at 90: 10 gap
      freezePoint: -2, freezeProduct: ICE,                  // ice melts at 2: 4 gap
      colors: ['#2563eb', '#3b82f6', '#1d4ed8', '#5d9bff'] }),

  m({ name: 'Oil', category: CAT.LIQUID, density: 800, dispersion: 3,
      conductivity: 0.15, flammability: 0.06,
      ignitionTemp: 200, burnHeat: 26, burnFuel: 70, ashProduct: EMPTY,
      colors: ['#3a352c', '#2e2a24', '#454033', '#26221d'] }),

  m({ name: 'Acid', category: CAT.LIQUID, density: 1200, dispersion: 3,
      corrosive: 1, emissive: 0.3, conductivity: 0.3,
      colors: ['#39ff14', '#2be80d', '#71ff52', '#1fd60a'] }),

  m({ name: 'Smoke', category: CAT.GAS, density: 0.5, dispersion: 3,
      life: [90, 200], conductivity: 0.1,
      colors: ['#4a4f57', '#565c65', '#3e424a', '#61666f'] }),

  m({ name: 'Fire', category: CAT.ENERGY, density: 0.2, life: [30, 90],
      emissive: 1, conductivity: 0.3, spawnTemp: 950,
      dousedByWater: true, buoyant: true,
      selfHeat: 999, selfHeatCap: 950,                      // a flame holds its own temperature
      colors: ['#ff4800', '#ff7a00', '#ffb300', '#ff2d00'] }),

  m({ name: 'Ash', category: CAT.POWDER, density: 600, friction: 0.35,
      corrosionResist: 0.1, conductivity: 0.1,
      colors: ['#5a5754', '#4b4845', '#6a6764', '#403d3b'] }),

  /* --------------------------- thermal family --------------------------- */

  m({ name: 'Ice', category: CAT.SOLID, density: 917,
      corrosionResist: 0.2, conductivity: 0.5, spawnTemp: -12,
      meltPoint: 2, meltProduct: WATER,                     // water freezes at -2: 4 gap
      colors: ['#a5e8ff', '#c8f2ff', '#8ad6f5', '#daf7ff'] }),

  m({ name: 'Snow', category: CAT.POWDER, density: 300, friction: 0.5,
      corrosionResist: 0.1, conductivity: 0.25, spawnTemp: -6,
      meltPoint: 1, meltProduct: WATER,
      colors: ['#f2fbff', '#e2f3fb', '#ffffff', '#d5ecf6'] }),

  m({ name: 'Steam', category: CAT.GAS, density: 0.3, dispersion: 4,
      conductivity: 0.12, spawnTemp: 110,
      condensePoint: 90, condenseProduct: WATER,            // water boils at 100: 10 gap
      colors: ['#b9c7d1', '#a4b3bf', '#cdd9e1', '#93a3b0'] }),

  m({ name: 'Lava', category: CAT.LIQUID, density: 2500, dispersion: 2,
      corrosionResist: 0.9, conductivity: 0.3, spawnTemp: 1300, emissive: 0.9,
      selfHeat: 12, selfHeatCap: 1300,                      // stays molten until actively quenched
      freezePoint: 950, freezeProduct: STONE,               // stone melts at 1200: 250 gap
      colors: ['#ff5a00', '#ff8c1a', '#e03d00', '#ffb03a'] }),

  m({ name: 'Glass', category: CAT.SOLID, density: 2500,
      corrosionResist: 0.6, conductivity: 0.2,
      meltPoint: 1250, meltProduct: MOLTEN_GLASS,           // freezes at 1000: 250 gap
      colors: ['#9fd8e8', '#b6e6f2', '#87c6d9', '#c9f0f8'] }),

  m({ name: 'Molten Glass', category: CAT.LIQUID, density: 2300, dispersion: 1,
      corrosionResist: 0.7, conductivity: 0.25, spawnTemp: 1400, emissive: 0.7,
      freezePoint: 1000, freezeProduct: GLASS,              // sand melts at 1200: 200 gap
      colors: ['#ffd27a', '#ffe3a8', '#ffbc4d', '#fff0cc'] }),

  m({ name: 'Metal', category: CAT.SOLID, density: 7800,
      corrosionResist: 0.55, conductivity: 1, blastResist: 6, // conducts heat fastest
      conducts: true, chargeDecay: 3, resistance: 0.004,
      meltPoint: 1500, meltProduct: MOLTEN_METAL,           // freezes at 1400: 100 gap
      colors: ['#b8c0cc', '#a2abb8', '#ccd4de', '#8f98a5'] }),

  m({ name: 'Molten Metal', category: CAT.LIQUID, density: 7000, dispersion: 2,
      corrosionResist: 0.6, conductivity: 0.9, spawnTemp: 1650, emissive: 0.8,
      conducts: true, chargeDecay: 3, resistance: 0.004,
      freezePoint: 1300, freezeProduct: METAL,              // metal melts at 1500: 200 gap
      colors: ['#ffdca8', '#ffe9c9', '#ffc978', '#fff4e0'] }),

  m({ name: 'Obsidian', category: CAT.SOLID, density: 2600,
      corrosionResist: 0.95, conductivity: 0.18, blastResist: 12,
      meltPoint: 1300, meltProduct: LAVA,
      colors: ['#241f2e', '#1a1622', '#302a3c', '#120f18'] }),

  /* --------------------------- chemical family --------------------------- */

  m({ name: 'Salt', category: CAT.POWDER, density: 1500, friction: 0.2,
      corrosionResist: 0.15, conductivity: 0.15, blastResist: 0.5,
      colors: ['#e8eef2', '#dbe3e9', '#f4f8fb', '#ccd6dd'] }),

  m({ name: 'Brine', category: CAT.LIQUID, density: 1150, dispersion: 5,
      conductivity: 0.38, blastResist: 0.2,
      conducts: true, chargeDecay: 2, resistance: 0.007,    // salt water carries it far
      boilPoint: 108, boilProduct: SALT,                    // evaporates, leaves its salt
      freezePoint: -18, freezeProduct: ICE,                 // ice melts at 2: 20 gap
      colors: ['#3f7fa8', '#4a8cb5', '#356f95', '#5b9cc4'] }),

  m({ name: 'Gunpowder', category: CAT.POWDER, density: 1300, friction: 0.3,
      corrosionResist: 0.1, conductivity: 0.2, blastResist: 0.3,
      ignitionTemp: 250, explodeRadius: 9, explodePower: 26,
      colors: ['#3a3a3f', '#2e2e33', '#46464c', '#26262a'] }),

  m({ name: 'Nitro', category: CAT.LIQUID, density: 1600, dispersion: 2,
      corrosionResist: 0.05, conductivity: 0.2, blastResist: 0.1,
      ignitionTemp: 110, explodeRadius: 18, explodePower: 70,
      colors: ['#c8b06a', '#d4bd7c', '#b89f57', '#e0cb92'] }),

  m({ name: 'Thermite', category: CAT.POWDER, density: 2100, friction: 0.4,
      corrosionResist: 0.4, conductivity: 0.3, blastResist: 1,
      // burns far hotter than wood and does not care about water: it is the
      // only thing in the roster that can drive stone and metal past melting
      ignitionTemp: 400, burnHeat: 90, burnFuel: 200, ashProduct: ASH,
      waterproofBurn: true, emissive: 0.5,
      colors: ['#8a4a2a', '#9c5834', '#7a3d21', '#a9663f'] }),

  m({ name: 'Gasoline', category: CAT.LIQUID, density: 750, dispersion: 4,
      conductivity: 0.15, blastResist: 0.1,
      ignitionTemp: 120, burnHeat: 34, burnFuel: 50, ashProduct: EMPTY,
      colors: ['#d9a066', '#e0ae78', '#c88f55', '#ecc192'] }),

  m({ name: 'Acid Vapor', category: CAT.GAS, density: 0.6, dispersion: 3,
      life: [70, 150], conductivity: 0.1, corrosive: 0.35, emissive: 0.25,
      colors: ['#7dff5a', '#6ae847', '#96ff7a', '#5cd63c'] }),

  /* -------------------------- biological family -------------------------- */

  m({ name: 'Seed', category: CAT.POWDER, density: 900, friction: 0.4,
      corrosionResist: 0.1, conductivity: 0.12, blastResist: 0.3,
      ignitionTemp: 260, burnHeat: 22, burnFuel: 60, ashProduct: ASH,
      colors: ['#7a5c2e', '#8a6a38', '#6a4e26', '#9a7a44'] }),

  // shade 2 is the stem, 3 the leaf, 1 the tip bud — see `sprig` in stamps.js
  m({ name: 'Plant', category: CAT.SOLID, density: 500,
      corrosionResist: 0.08, conductivity: 0.13, blastResist: 0.4,
      ignitionTemp: 240, burnHeat: 24, burnFuel: 90, ashProduct: ASH,
      stamp: 'sprig',
      colors: ['#4a9c3a', '#57b045', '#3e8730', '#68c455'] }),

  m({ name: 'Vine', category: CAT.SOLID, density: 520,
      corrosionResist: 0.08, conductivity: 0.13, blastResist: 0.4,
      ignitionTemp: 240, burnHeat: 24, burnFuel: 90, ashProduct: ASH,
      colors: ['#3d7f30', '#478f39', '#346f28', '#549b45'] }),

  // The old palette was four shades of the same pale lilac, which is why a
  // painted blob of it read as nothing at all. Shades 0/1 are now a DARK cap and
  // its lighter rim, 2/3 a pale stem — that contrast is the entire reason the
  // mushroom stamp is legible without adding a second material.
  m({ name: 'Fungus', category: CAT.SOLID, density: 400,
      corrosionResist: 0.08, conductivity: 0.1, blastResist: 0.3,
      ignitionTemp: 220, burnHeat: 20, burnFuel: 70, ashProduct: ASH,
      stamp: 'mushroom',
      colors: ['#7c5f92', '#9a78b4', '#e6dcf0', '#cfc2de'] }),

  /* --------------------------- energy family --------------------------- */

  /*
   * The circuit-building materials (Wire, Battery, Fuse, Switch, Lamp, Fan) were
   * removed deliberately: they made this a logic toy as well as a physics one,
   * and only one of those is the point.
   *
   * The charge field stayed, because everything interesting about it is physics
   * rather than circuitry — current spreading through a water body, resistive
   * heating boiling brine dry to salt, a charge setting off gunpowder. What it
   * lost was its only source, so SPARK took that job. A spark lives 8-22 frames,
   * so you can zap something and watch the consequences, but you cannot wire up a
   * permanent supply. That is exactly the line we wanted.
   */
  m({ name: 'Spark', category: CAT.ENERGY, density: 0.15, life: [8, 22],
      emissive: 1, conductivity: 0.4, spawnTemp: 1500,
      conducts: true, emitsCharge: true, chargeDecay: 2, blastResist: 0,
      colors: ['#9fd0ff', '#ffffff', '#5fa8ff', '#d8ecff'] }),

  m({ name: 'Plasma', category: CAT.GAS, density: 0.2, dispersion: 3,
      life: [40, 100], emissive: 1, conductivity: 0.5, spawnTemp: 3200,
      selfHeat: 40, selfHeatCap: 3200, conducts: true, chargeDecay: 6,
      blastResist: 0,
      colors: ['#c98cff', '#e6c2ff', '#a75cff', '#f5e4ff'] }),

  // Placed by the emitter tool; `aux` holds the material it pours. Deliberately
  // tough, so a scene built around it is not destroyed by its own output.
  m({ name: 'Emitter', category: CAT.EMITTER, density: 5000,
      corrosionResist: 1, conductivity: 0.2, blastResist: 20,
      colors: ['#e0e7ef', '#8fa3b8', '#c2d0de', '#6f8298'] }),

  // NOTE: array position IS the material id, so anything added here must go at
  // the END and its constant above must match. Inserting or REMOVING mid-table
  // renumbers every material after it and silently rewrites saved scenes — which
  // is why the scene codec's VERSION was bumped when the circuit family went.
];

export const MAT_COUNT = MATERIALS.length;

/** Flat lookup tables. Hot loops read these instead of walking objects. */
export const CATEGORY = new Uint8Array(MAT_COUNT);
export const DENSITY = new Float32Array(MAT_COUNT);
export const DISPERSION = new Uint8Array(MAT_COUNT);
export const FRICTION = new Float32Array(MAT_COUNT);
export const CORROSIVE = new Float32Array(MAT_COUNT);
export const CORROSION_RESIST = new Float32Array(MAT_COUNT);
export const FLAMMABILITY = new Float32Array(MAT_COUNT);
export const LIFE_MIN = new Uint16Array(MAT_COUNT);
export const LIFE_SPAN = new Uint16Array(MAT_COUNT);
export const DOUSED_BY_WATER = new Uint8Array(MAT_COUNT);
export const BUOYANT = new Uint8Array(MAT_COUNT);

export const CONDUCTIVITY = new Float32Array(MAT_COUNT);
export const SPAWN_TEMP = new Float32Array(MAT_COUNT);
export const MELT_POINT = new Float32Array(MAT_COUNT);
export const MELT_PRODUCT = new Uint8Array(MAT_COUNT);
export const BOIL_POINT = new Float32Array(MAT_COUNT);
export const BOIL_PRODUCT = new Uint8Array(MAT_COUNT);
export const FREEZE_POINT = new Float32Array(MAT_COUNT);
export const FREEZE_PRODUCT = new Uint8Array(MAT_COUNT);
export const CONDENSE_POINT = new Float32Array(MAT_COUNT);
export const CONDENSE_PRODUCT = new Uint8Array(MAT_COUNT);
export const CONDUCTS = new Uint8Array(MAT_COUNT);
export const EMITS_CHARGE = new Uint8Array(MAT_COUNT);
export const CHARGE_DECAY = new Uint8Array(MAT_COUNT);
export const RESISTANCE = new Float32Array(MAT_COUNT);
export const BLAST_RESIST = new Float32Array(MAT_COUNT);
export const EXPLODE_RADIUS = new Uint8Array(MAT_COUNT);
export const EXPLODE_POWER = new Float32Array(MAT_COUNT);
export const WATERPROOF_BURN = new Uint8Array(MAT_COUNT);
export const SELF_HEAT = new Float32Array(MAT_COUNT);
export const SELF_HEAT_CAP = new Float32Array(MAT_COUNT);
export const IGNITION_TEMP = new Float32Array(MAT_COUNT);
export const BURN_HEAT = new Float32Array(MAT_COUNT);
export const BURN_FUEL = new Uint8Array(MAT_COUNT);
export const ASH_PRODUCT = new Uint8Array(MAT_COUNT);
/** Stamp generator name per material, or null. Read by the brush, not a hot loop. */
export const STAMP = new Array(MAT_COUNT).fill(null);

for (let i = 0; i < MAT_COUNT; i++) {
  const M = MATERIALS[i];
  CATEGORY[i] = M.category;
  DENSITY[i] = M.density;
  DISPERSION[i] = M.dispersion;
  FRICTION[i] = M.friction;
  CORROSIVE[i] = M.corrosive;
  CORROSION_RESIST[i] = M.corrosionResist;
  FLAMMABILITY[i] = M.flammability;
  LIFE_MIN[i] = M.life[0];
  LIFE_SPAN[i] = Math.max(1, M.life[1] - M.life[0]);
  DOUSED_BY_WATER[i] = M.dousedByWater ? 1 : 0;
  BUOYANT[i] = M.buoyant ? 1 : 0;

  CONDUCTIVITY[i] = Math.max(0, Math.min(1, M.conductivity));
  SPAWN_TEMP[i] = M.spawnTemp;
  MELT_POINT[i] = M.meltPoint;       MELT_PRODUCT[i] = M.meltProduct;
  BOIL_POINT[i] = M.boilPoint;       BOIL_PRODUCT[i] = M.boilProduct;
  FREEZE_POINT[i] = M.freezePoint;   FREEZE_PRODUCT[i] = M.freezeProduct;
  CONDENSE_POINT[i] = M.condensePoint; CONDENSE_PRODUCT[i] = M.condenseProduct;
  CONDUCTS[i] = M.conducts ? 1 : 0;
  EMITS_CHARGE[i] = M.emitsCharge ? 1 : 0;
  CHARGE_DECAY[i] = M.chargeDecay;
  RESISTANCE[i] = M.resistance;
  BLAST_RESIST[i] = M.blastResist;
  EXPLODE_RADIUS[i] = M.explodeRadius;
  EXPLODE_POWER[i] = M.explodePower;
  WATERPROOF_BURN[i] = M.waterproofBurn ? 1 : 0;
  SELF_HEAT[i] = M.selfHeat;
  SELF_HEAT_CAP[i] = M.selfHeatCap;
  IGNITION_TEMP[i] = M.ignitionTemp;
  BURN_HEAT[i] = M.burnHeat;
  BURN_FUEL[i] = M.burnFuel;
  ASH_PRODUCT[i] = M.ashProduct;
  STAMP[i] = M.stamp;
}

/** True if the material has any temperature-driven transition at all. */
export const HAS_TRANSITION = new Uint8Array(MAT_COUNT);
for (let i = 0; i < MAT_COUNT; i++) {
  HAS_TRANSITION[i] = (MELT_POINT[i] < Infinity || BOIL_POINT[i] < Infinity ||
                       FREEZE_POINT[i] > -Infinity || CONDENSE_POINT[i] > -Infinity ||
                       IGNITION_TEMP[i] < Infinity || SELF_HEAT[i] > 0 ||
                       EXPLODE_POWER[i] > 0) ? 1 : 0;
}

/** True for materials another material can push aside (fluids). */
export const IS_FLUID = new Uint8Array(MAT_COUNT);
for (let i = 0; i < MAT_COUNT; i++) {
  IS_FLUID[i] = (CATEGORY[i] === CAT.LIQUID || CATEGORY[i] === CAT.GAS) ? 1 : 0;
}

/** True for materials acid can eat through. */
export const IS_CORRODIBLE = new Uint8Array(MAT_COUNT);
for (let i = 0; i < MAT_COUNT; i++) {
  const c = CATEGORY[i];
  IS_CORRODIBLE[i] = (c === CAT.POWDER || c === CAT.SOLID || c === CAT.RIGID)
                     && CORROSION_RESIST[i] < 1 ? 1 : 0;
}

/** Packed palette for the Canvas2D renderer: index = (mat << 2) | shade. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

export function hexToU32(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return LITTLE_ENDIAN
    ? (((255 << 24) | (b << 16) | (g << 8) | r) >>> 0)
    : (((r << 24) | (g << 16) | (b << 8) | 255) >>> 0);
}

export const PALETTE_U32 = new Uint32Array(MAT_COUNT * 4);
for (let t = 0; t < MAT_COUNT; t++) {
  for (let s = 0; s < 4; s++) PALETTE_U32[(t << 2) | s] = hexToU32(MATERIALS[t].colors[s]);
}

/**
 * Palette as a GL-ready RGBA byte strip, one texel per (material, shade) pair.
 * Alpha carries emissive strength rather than opacity — the scene shader reads
 * it to decide what feeds the bloom pass.
 */
export const PALETTE_RGBA = new Uint8Array(MAT_COUNT * 4 * 4);
for (let t = 0; t < MAT_COUNT; t++) {
  const M = MATERIALS[t];
  for (let s = 0; s < 4; s++) {
    // per-shade glow when the material declares it, so a lamp can be dark in one
    // shade and blazing in another without a second material
    const e = M.emissiveShades ? M.emissiveShades[s] : M.emissive;
    const n = parseInt(M.colors[s].slice(1), 16);
    const o = ((t * 4) + s) * 4;
    PALETTE_RGBA[o] = (n >> 16) & 255;
    PALETTE_RGBA[o + 1] = (n >> 8) & 255;
    PALETTE_RGBA[o + 2] = n & 255;
    PALETTE_RGBA[o + 3] = Math.round(Math.max(0, Math.min(1, e)) * 255);
  }
}
