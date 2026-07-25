/**
 * Scene serialisation, undo, presets.
 *
 * A scene is not just the material grid: temperature, charge and per-cell
 * scratch all have to survive a round trip, or a reloaded scene looks right
 * for one frame and then behaves differently. Everything is run-length encoded
 * (a sandbox is overwhelmingly runs of empty and flat terrain) and gzipped
 * through the platform's own CompressionStream for the share link.
 */

import { G, initGrid, setCell, clearGrid, AMBIENT } from './grid.js';
import { SAND, WATER, WALL, WOOD, STONE, LAVA, ICE, OIL, SEED, GUNPOWDER,
         METAL, WIRE, BATTERY, BRINE, PLANT, EMPTY, MAT_COUNT,
         FUSE, SWITCH, LAMP, FAN } from './materials.js';
import { clearParticles } from './particles.js';
import { drawStamp } from './stamps.js';

const MAGIC = 0x5344;   // "SD"
const VERSION = 1;

/* ------------------------------ byte writer ------------------------------ */

class Writer {
  constructor() { this.buf = new Uint8Array(1024); this.len = 0; }
  need(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v) { this.need(1); this.buf[this.len++] = v & 255; }
  u16(v) { this.u8(v >> 8); this.u8(v); }
  /** LEB128-style varint: run lengths are usually tiny, occasionally huge. */
  varint(v) {
    this.need(5);
    while (v >= 0x80) { this.buf[this.len++] = (v & 0x7f) | 0x80; v >>>= 7; }
    this.buf[this.len++] = v;
  }
  f32(v) {
    this.need(4);
    new DataView(this.buf.buffer).setFloat32(this.len, v, true);
    this.len += 4;
  }
  bytes() { return this.buf.subarray(0, this.len); }
}

class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  u8() { return this.b[this.p++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  varint() {
    let v = 0, shift = 0, byte;
    do { byte = this.b[this.p++]; v |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return v >>> 0;
  }
  f32() { const v = this.view.getFloat32(this.p, true); this.p += 4; return v; }
}

/* --------------------------------- codec --------------------------------- */

function rleU8(w, arr) {
  const n = arr.length;
  let i = 0;
  while (i < n) {
    const v = arr[i];
    let run = 1;
    while (i + run < n && arr[i + run] === v) run++;
    w.u8(v); w.varint(run);
    i += run;
  }
}

function unrleU8(r, arr) {
  let i = 0;
  while (i < arr.length) {
    const v = r.u8(), run = r.varint();
    arr.fill(v, i, i + run);
    i += run;
  }
}

/**
 * Temperature is quantised to 0.25C and run-length encoded as u16.
 *
 * Stored as raw float32 it dominated the payload — 81% of a 253kB scene,
 * because a diffused field has a different value in almost every cell and RLE
 * finds no runs at all. Quantising collapses large ambient regions back into
 * long runs. 0.25C is far below the resolution of the 8-bit blackbody ramp the
 * shader draws with, so the rendered image is unchanged; the round-trip test
 * compares actual pixels to keep that claim honest.
 */
const TEMP_BIAS = 273;           // shift so absolute zero maps to 0
/**
 * Two resolutions, chosen by whether the cell holds anything.
 *
 * An empty cell always renders as the EMPTY palette entry — the shader zeroes
 * its glow outright — so air temperature cannot move a pixel and only needs to
 * be good enough to keep the simulation continuous. Storing air at the same
 * 0.25C as material was 72% of the entire payload, because plumes above fires
 * give almost every air cell a slightly different value and RLE finds no runs.
 */
const TEMP_SCALE_MATERIAL = 4;   // 0.25C
const TEMP_SCALE_AIR = 0.25;     // 4C

const tempScaleFor = (matVal) => (matVal === EMPTY ? TEMP_SCALE_AIR : TEMP_SCALE_MATERIAL);

function quantTempAt(matVal, v) {
  let q = Math.round((v + TEMP_BIAS) * tempScaleFor(matVal));
  if (q < 0) q = 0; else if (q > 65535) q = 65535;
  return q;
}

const dequantTempAt = (matVal, q) => q / tempScaleFor(matVal) - TEMP_BIAS;

/** Hot cells are never empty, so this always uses the material scale. */
function quantTemp(v) {
  let q = Math.round((v + TEMP_BIAS) * TEMP_SCALE_MATERIAL);
  if (q < 0) q = 0; else if (q > 65535) q = 65535;
  return q;
}

/**
 * Above this, temperature drives the shader's blackbody ramp and therefore the
 * rendered colour, so those cells get their exact float stored on top of the
 * quantised stream. Quantisation alone left ~80 pixels of a busy 144k-cell
 * scene off by one 8-bit level, because 0.25C is ~0.09 of a colour level and
 * occasionally straddles a rounding boundary. Finer steps only shrink that
 * probability; exact values remove it.
 *
 * Set at the shader's own 500C threshold, not below it: `smoothstep(500,1200)`
 * is exactly 0 underneath, so a cooler cell's temperature cannot move a pixel
 * and costs nothing to approximate. An earlier 480C margin swept in the whole
 * thermal halo around every fire and tripled the payload for no visual gain.
 * Tested against the QUANTISED value so encoder and decoder always select
 * exactly the same set of cells.
 */
const HOT_THRESHOLD_Q = quantTemp(500);

/** A run must not straddle empty/non-empty cells: the stored value means a
 *  different temperature on each side of that boundary. */
function rleTemp(w, mat, temp) {
  const n = temp.length;
  let i = 0;
  while (i < n) {
    const empty = mat[i] === EMPTY;
    const q = quantTempAt(mat[i], temp[i]);
    let run = 1;
    while (i + run < n
           && (mat[i + run] === EMPTY) === empty
           && quantTempAt(mat[i + run], temp[i + run]) === q) run++;
    w.u16(q); w.varint(run);
    i += run;
  }
}

function unrleTemp(r, mat, temp) {
  let i = 0;
  while (i < temp.length) {
    const q = r.u16(), run = r.varint();
    for (let k = 0; k < run; k++) temp[i + k] = dequantTempAt(mat[i + k], q);
    i += run;
  }
}

function isHot(mat, temp, i) {
  return mat[i] !== EMPTY && quantTemp(temp[i]) >= HOT_THRESHOLD_Q;
}

/** Exact floats for the visually hot cells, RLE'd — lava and fire sit at flat
 *  capped temperatures, so these compress far better than the raw field did. */
function writeHotTemps(w, mat, temp) {
  const n = mat.length;
  let i = 0;
  while (i < n) {
    if (!isHot(mat, temp, i)) { i++; continue; }
    const v = temp[i];
    let run = 1;
    while (i + run < n && isHot(mat, temp, i + run) && Object.is(temp[i + run], v)) run++;
    w.f32(v); w.varint(run);
    i += run;
  }
}

function readHotTemps(r, mat, temp) {
  const n = mat.length;
  let i = 0, remaining = 0, value = 0;
  while (i < n) {
    if (!isHot(mat, temp, i)) { i++; continue; }
    if (remaining === 0) { value = r.f32(); remaining = r.varint(); }
    temp[i] = value;
    remaining--;
    i++;
  }
}

/**
 * Shade is a random 0..3 per cell, so RLE actively inflates it. It is packed
 * four cells to a byte, and only for non-empty cells: an empty cell renders
 * from the EMPTY palette entry regardless of its shade, and `setCell` assigns
 * a fresh one whenever anything is placed there.
 */
function packShade(w, mat, shade) {
  let acc = 0, bits = 0;
  for (let i = 0; i < mat.length; i++) {
    if (mat[i] === EMPTY) continue;
    acc |= (shade[i] & 3) << bits;
    bits += 2;
    if (bits === 8) { w.u8(acc); acc = 0; bits = 0; }
  }
  if (bits > 0) w.u8(acc);
}

function unpackShade(r, mat, shade) {
  let acc = 0, bits = 0;
  for (let i = 0; i < mat.length; i++) {
    if (mat[i] === EMPTY) { shade[i] = 0; continue; }
    if (bits === 0) { acc = r.u8(); bits = 8; }
    shade[i] = acc & 3;
    acc >>= 2;
    bits -= 2;
  }
}

/** Serialise the whole simulation state to bytes. */
export function encodeScene() {
  const w = new Writer();
  w.u16(MAGIC);
  w.u8(VERSION);
  w.u8(MAT_COUNT);        // so a scene from a different roster is rejected
  w.u16(G.w);
  w.u16(G.h);
  rleU8(w, G.mat);
  rleU8(w, G.aux);
  rleU8(w, G.flags);
  rleU8(w, G.charge);
  rleTemp(w, G.mat, G.temp);
  writeHotTemps(w, G.mat, G.temp);
  packShade(w, G.mat, G.shade);   // last: needs `mat` decoded first
  return w.bytes();
}

/** Restore a scene, resizing the grid if the saved one differs. */
export function decodeScene(bytes) {
  const r = new Reader(bytes);
  if (r.u16() !== MAGIC) throw new Error('not a sandbox scene');
  const version = r.u8();
  if (version !== VERSION) throw new Error(`unsupported scene version ${version}`);
  const matCount = r.u8();
  if (matCount !== MAT_COUNT) throw new Error('scene was saved with a different material set');
  const w = r.u16(), h = r.u16();

  initGrid(w, h);
  clearParticles();
  unrleU8(r, G.mat);
  unrleU8(r, G.aux);
  unrleU8(r, G.flags);
  unrleU8(r, G.charge);
  unrleTemp(r, G.mat, G.temp);
  readHotTemps(r, G.mat, G.temp);
  unpackShade(r, G.mat, G.shade);
  G.active.fill(1);
  G.activeNext.fill(1);
  G.tempVersion++;
  return { w, h };
}

/* ------------------------------- base64 ------------------------------- */

export function toBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;   // avoid blowing the argument limit on big scenes
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* --------------------------------- gzip --------------------------------- */

async function pipeThrough(bytes, stream) {
  const blob = new Blob([bytes]);
  const piped = blob.stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return bytes;
  return pipeThrough(bytes, new CompressionStream('gzip'));
}

export async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') return bytes;
  return pipeThrough(bytes, new DecompressionStream('gzip'));
}

/* ------------------------------- share URL ------------------------------- */

export async function makeShareUrl() {
  const packed = await gzip(encodeScene());
  const url = `${location.origin}${location.pathname}#s=${toBase64(packed)}`;
  return { url, bytes: packed.length };
}

/** Load a scene from the location fragment. Returns true if one was applied. */
export async function loadFromHash() {
  const m = location.hash.match(/[#&]s=([A-Za-z0-9\-_]+)/);
  if (!m) return false;
  try {
    decodeScene(await gunzip(fromBase64(m[1])));
    return true;
  } catch (e) {
    console.warn('Could not load the scene from the URL:', e.message);
    return false;
  }
}

/* -------------------------------- storage -------------------------------- */

const SLOT_KEY = (n) => `sandbox.slot.${n}`;
export const SLOT_COUNT = 3;

export function saveSlot(n) {
  localStorage.setItem(SLOT_KEY(n), toBase64(encodeScene()));
}

export function loadSlot(n) {
  const raw = localStorage.getItem(SLOT_KEY(n));
  if (!raw) return false;
  decodeScene(fromBase64(raw));
  return true;
}

export function slotFilled(n) {
  return localStorage.getItem(SLOT_KEY(n)) !== null;
}

export function downloadScene() {
  const blob = new Blob([encodeScene()], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'scene.sand';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* --------------------------------- undo --------------------------------- */

const UNDO_LIMIT = 20;
const undoStack = [];
const redoStack = [];

/** Snapshot before an edit. Stored RLE-compressed but not gzipped: this has to
 *  be synchronous, and RLE alone already shrinks a typical scene enormously. */
export function pushUndo() {
  undoStack.push(encodeScene());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(encodeScene());
  decodeScene(undoStack.pop());
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(encodeScene());
  decodeScene(redoStack.pop());
  return true;
}

export function undoDepth() { return undoStack.length; }
export function redoDepth() { return redoStack.length; }
export function clearHistory() { undoStack.length = 0; redoStack.length = 0; }

/* -------------------------------- shapes -------------------------------- */

export function fillRect(x0, y0, x1, y1, t) {
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= G.h) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= G.w) continue;
      setCell(y * G.w + x, t);
    }
  }
}

export function fillBlob(cx, cy, r, t, density) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= G.w || y < 0 || y >= G.h) continue;
      if (Math.random() < density) setCell(y * G.w + x, t);
    }
  }
}

/* -------------------------------- presets -------------------------------- */

/** Presets are authored in 200x125 space and scaled; aspect is fixed at 8:5. */
function scaled(fn) {
  const s = G.w / 200;
  const R = (x0, y0, x1, y1, t) =>
    fillRect(Math.round(x0 * s), Math.round(y0 * s), Math.round(x1 * s), Math.round(y1 * s), t);
  const B = (cx, cy, r, t, d) =>
    fillBlob(Math.round(cx * s), Math.round(cy * s), Math.max(1, Math.round(r * s)), t, d);
  const T = (x0, y0, x1, y1, deg) => {
    for (let y = Math.round(y0 * s); y <= Math.round(y1 * s); y++) {
      for (let x = Math.round(x0 * s); x <= Math.round(x1 * s); x++) {
        if (x >= 0 && x < G.w && y >= 0 && y < G.h) G.temp[y * G.w + x] = deg;
      }
    }
    G.tempVersion++;
  };
  /** Stamp a shape from stamps.js. Presets write into empty space only. */
  const S = (name, x, y, size) =>
    drawStamp(name, Math.round(x * s), Math.round(y * s), Math.max(1, Math.round(size * s)),
      (px, py, mat, shade) => {
        if (px < 0 || px >= G.w || py < 0 || py >= G.h) return;
        const i = py * G.w + px;
        if (G.mat[i] !== EMPTY) return;
        setCell(i, mat);
        G.shade[i] = shade & 3;
      });
  /** Set per-cell `aux` over a scaled rect: a fan's facing, a switch's state. */
  const A = (x0, y0, x1, y1, value) => {
    for (let y = Math.round(y0 * s); y <= Math.round(y1 * s); y++) {
      for (let x = Math.round(x0 * s); x <= Math.round(x1 * s); x++) {
        if (x >= 0 && x < G.w && y >= 0 && y < G.h) G.aux[y * G.w + x] = value;
      }
    }
  };
  fn(R, B, T, S, A);
}

export const PRESETS = [
  {
    id: 'cabin', name: 'Cabin',
    build: () => scaled((R, B) => {
      R(14, 58, 78, 59, WALL);
      R(104, 92, 190, 93, WALL);
      R(122, 60, 124, 91, WOOD);
      R(160, 60, 162, 91, WOOD);
      R(122, 58, 162, 60, WOOD);
      B(45, 30, 11, SAND, 0.85);
      B(142, 18, 12, WATER, 0.8);
    }),
  },
  {
    id: 'volcano', name: 'Volcano',
    build: () => scaled((R, B) => {
      R(0, 118, 199, 124, STONE);
      for (let i = 0; i < 40; i++) R(60 + i, 118 - i, 140 - i, 118, STONE);
      R(96, 40, 104, 118, LAVA);
      B(100, 38, 6, LAVA, 1);
      B(30, 20, 10, WATER, 0.8);
    }),
  },
  {
    id: 'flood', name: 'Flood Valley',
    build: () => scaled((R, B) => {
      R(0, 118, 199, 124, STONE);
      R(0, 90, 40, 118, STONE);
      R(160, 90, 199, 118, STONE);
      R(60, 20, 140, 60, WATER);
      R(70, 100, 130, 118, WOOD);
    }),
  },
  {
    id: 'forest', name: 'Forest Fire',
    build: () => scaled((R, B, T, S) => {
      R(0, 118, 199, 124, STONE);
      R(0, 112, 199, 118, SEED);
      // Trees, not bare poles: trunk plus a plant canopy, so the fire has
      // something to spread THROUGH instead of only up each trunk. Heights
      // alternate so the crowns overlap unevenly and the front is ragged.
      for (let i = 0, x = 12; x < 190; x += 22, i++) {
        S('tree', x, 114, 7 + (i % 3) * 2);
      }
      T(6, 92, 14, 118, 900);
    }),
  },
  {
    id: 'terrarium', name: 'Terrarium',
    build: () => scaled((R, B) => {
      R(0, 118, 199, 124, STONE);
      R(20, 40, 22, 118, WALL);
      R(178, 40, 180, 118, WALL);
      R(20, 38, 180, 40, WALL);
      R(23, 110, 177, 118, WATER);
      R(40, 106, 160, 108, SEED);
      B(100, 60, 14, WATER, 0.5);
    }),
  },
  {
    id: 'circuit', name: 'Circuit Board',
    /*
     * Every run here is kept SHORT on purpose. Charge starts at 255 and wire
     * loses 1 per hop, so anything further than ~215 cells from the battery
     * cannot light a lamp (which needs 40 to read as lit). The first version of
     * this preset put the lamp 305 cells away and it simply never came on.
     * Rect ends are shared (…45, 45…) so scaling to the live grid cannot open a
     * gap between two segments.
     */
    build: () => scaled((R, B, T, S, A) => {
      R(0, 118, 199, 124, WALL);
      R(6, 52, 13, 68, BATTERY);

      // Supply -> switch -> lamp. Select Switch and click it to cut the light.
      // Deliberately wide: a narrow break just gets arced across.
      R(13, 59, 45, 61, WIRE);
      R(45, 59, 51, 61, SWITCH);
      R(51, 59, 74, 61, WIRE);
      R(74, 53, 82, 67, LAMP);

      // A fuse hanging off the same rail. It carries the same current as the
      // wire above it and burns through anyway — that is the whole difference.
      R(20, 61, 23, 80, WIRE);
      R(20, 80, 23, 98, FUSE);

      // A fan on the rail, blowing across an oil trough. Oil rather than water
      // because oil does NOT conduct: a conductive fluid touching the fan gets
      // electrolysed and boiled instead of blown, which hides the effect.
      R(30, 61, 33, 100, WIRE);
      R(28, 100, 35, 112, FAN);
      A(28, 100, 35, 112, 1);           // facing right, across the trough
      // Kept small on purpose. Liquid sideways-dispersion is the engine's
      // dominant per-frame cost, and a trough twice this size took the preset
      // from 4.6 to 9.9 ms of sim on its own — none of it electrical.
      R(40, 113, 96, 118, OIL);
    }),
  },
  {
    id: 'demolition', name: 'Demolition',
    build: () => scaled((R, B, T) => {
      R(0, 118, 199, 124, WALL);
      R(30, 70, 90, 118, STONE);
      R(110, 70, 170, 118, STONE);
      R(50, 100, 70, 118, GUNPOWDER);
      R(130, 100, 150, 118, GUNPOWDER);
      R(95, 40, 105, 70, ICE);
      T(50, 99, 52, 101, 900);
    }),
  },
  {
    id: 'refinery', name: 'Refinery',
    build: () => scaled((R, B, T) => {
      R(0, 118, 199, 124, WALL);
      R(20, 60, 23, 118, WALL);
      R(90, 60, 93, 118, WALL);
      R(24, 96, 89, 118, OIL);
      R(24, 80, 89, 94, WATER);
      R(110, 60, 113, 118, WALL);
      R(180, 60, 183, 118, WALL);
      R(114, 100, 179, 118, LAVA);
      R(114, 70, 179, 80, SAND);
    }),
  },
];

export function applyPreset(id) {
  const p = PRESETS.find(x => x.id === id);
  if (!p) return false;
  clearGrid();
  clearParticles();
  p.build();
  return true;
}

/** The scene shown on a cold start. */
export function seedScene() {
  applyPreset('cabin');
}
