/**
 * Wiring + main loop.
 */

import { G, initGrid, resizeGrid, clearGrid, awakeChunkCount, countParticles } from './grid.js';
import { stepSim } from './sim.js';
import { createRenderer, VIEW } from './renderer.js';
import { tool, toolDown, toolDrag, toolUp, cancelDrag, DRAG_TOOLS } from './tools.js';
import { seedScene, pushUndo, loadFromHash, clearHistory } from './scene.js';
import {
  initUI, setStats, setInspector, syncPaused, selectMaterial, refreshMaterial, toolReach,
} from './ui.js';
import { EMPTY, SAND } from './materials.js';
import { clearParticles, particleCount } from './particles.js';
import { explode } from './explosions.js';

const canvas = document.getElementById('sim');
const stage = document.getElementById('stage');
const ring = document.getElementById('brushRing');
const renderer = createRenderer(canvas, new URLSearchParams(location.search).get('renderer'));


const MAX_W = 480, MAX_H = 300;   // aspect locked at 8:5
const SIM_DT = 1000 / 60;

const params = new URLSearchParams(location.search);
// ?paused starts frozen, so a shared scene can be inspected exactly as saved
let paused = params.has('paused'), stepOnce = false, viewMode = VIEW.NORMAL, speed = 1;

function computeGridSize() {
  const cssW = stage.clientWidth || 800;
  const gw = Math.max(160, Math.min(MAX_W, Math.round(cssW / 2 / 8) * 8));
  return [gw, Math.min(MAX_H, (gw * 5 / 8) | 0)];
}

function applySize(preserve) {
  const [gw, gh] = computeGridSize();
  if (gw === G.w && gh === G.h) return;
  if (preserve) resizeGrid(gw, gh); else initGrid(gw, gh);
  renderer.resize(gw, gh);
}

/* ------------------------------- boot ------------------------------- */

const [gw0, gh0] = computeGridSize();
initGrid(gw0, gh0);
renderer.resize(gw0, gh0);

/** Load the scene this URL asks for. Also the reset path after self-checks. */
async function bootScene() {
  // a shared link wins over the default scene, and resizes the grid to match
  if (await loadFromHash()) renderer.resize(G.w, G.h);
  else seedScene();
  clearHistory();
}
await bootScene();

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => applySize(true), 200);
});

/* ------------------------------ pointer ------------------------------ */

let pointerDown = false, erasing = false, inside = false;
let curX = 0, curY = 0, lastX = 0, lastY = 0;

function toGrid(e) {
  const r = canvas.getBoundingClientRect();
  const gx = Math.floor((e.clientX - r.left) / r.width * G.w);
  const gy = Math.floor((e.clientY - r.top) / r.height * G.h);
  return [Math.max(0, Math.min(G.w - 1, gx)), Math.max(0, Math.min(G.h - 1, gy))];
}

function moveRing(e) {
  const r = canvas.getBoundingClientRect();
  const cell = r.width / G.w;
  // the ring shows the ARMED TOOL's reach, not the brush slider — a gravity well
  // acts far outside its footprint and used to draw a circle that lied about it
  const d = Math.max((toolReach() * 2 + 1) * cell, 6);
  ring.style.width = d + 'px';
  ring.style.height = d + 'px';
  ring.style.left = Math.max(0, Math.min(r.width, e.clientX - r.left)) + 'px';
  ring.style.top = Math.max(0, Math.min(r.height, e.clientY - r.top)) + 'px';
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  pointerDown = true;
  erasing = e.button === 2;
  pushUndo();                 // one snapshot per stroke, not per frame
  const p = toGrid(e);
  curX = p[0]; curY = p[1]; lastX = curX; lastY = curY;
  toolDown(curX, curY, erasing);
  ring.style.display = 'block';
  moveRing(e);
});

canvas.addEventListener('pointermove', (e) => {
  const p = toGrid(e);
  curX = p[0]; curY = p[1];
  inside = true;
  ring.style.display = 'block';
  moveRing(e);
});

canvas.addEventListener('pointerup', (e) => {
  if (pointerDown) {
    const p = toGrid(e);
    toolUp(p[0], p[1]);
  }
  pointerDown = false;
});
canvas.addEventListener('pointercancel', () => { pointerDown = false; cancelDrag(); });
canvas.addEventListener('pointerleave', () => {
  inside = false;
  if (!pointerDown) ring.style.display = 'none';
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* -------------------------------- UI -------------------------------- */

initUI({
  togglePause() { paused = !paused; syncPaused(paused); },
  step() { paused = true; syncPaused(paused); stepOnce = true; },
  clear() { pushUndo(); clearGrid(); clearParticles(); },
  beforeEdit() { pushUndo(); },
  setView(v) { viewMode = v; },
  setSpeed(v) { speed = v; },
});
selectMaterial(SAND);
syncPaused(paused);

// Self-checks run AFTER the UI exists, so DOM affordances (ring reach, tool
// arming, scroll containment) are testable in the same harness as the physics.
// They scribble all over the grid, hence the reload afterwards.
if (location.search.includes('selfcheck')) {
  const { runSelfChecks } = await import('./selfcheck.js');
  runSelfChecks();
  renderer.resize(G.w, G.h);
  await bootScene();
}

/* ------------------------------ main loop ------------------------------ */

let lastT = performance.now(), acc = 0, fpsSm = 60, msSm = 0, statT = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(now - lastT, 100);
  lastT = now;
  if (dt > 0) fpsSm += (1000 / dt - fpsSm) * 0.08;

  // drag-shape tools only commit on release, so they must not paint per frame
  if (pointerDown && !DRAG_TOOLS.has(tool.id)) {
    toolDrag(lastX, lastY, curX, curY, erasing);
    lastX = curX; lastY = curY;
  }

  const t0 = performance.now();

  if (!paused) {
    acc += dt * speed;
    let n = 0;
    while (acc >= SIM_DT && n < 4) { stepSim(); acc -= SIM_DT; n++; }
    if (n === 4) acc = 0;   // drop the backlog after a stall instead of spiralling
  } else {
    acc = 0;
    if (stepOnce) { stepSim(); stepOnce = false; }
  }

  renderer.draw(viewMode);
  msSm += ((performance.now() - t0) - msSm) * 0.08;

  setInspector(curX, curY, inside);
  refreshMaterial();      // the eyedropper sets tool.material itself; keep chips honest

  if (now - statT > 400) {
    statT = now;
    setStats({
      fps: Math.round(Math.min(fpsSm, 999)),
      ms: msSm.toFixed(1),
      count: countParticles().toLocaleString(),
      particles: particleCount(),
      chunks: `${awakeChunkCount()}/${G.cn}`,
      w: G.w, h: G.h, renderer: renderer.kind,
    });
  }
}
requestAnimationFrame(loop);

// exposed so a headless driver can poke the simulation directly
window.__sim = {
  G, stepSim, tool, toolDown, toolDrag, toolUp, clearGrid, awakeChunkCount,
  renderer, explode, particleCount, clearParticles,
};
