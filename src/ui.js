/**
 * Control panel: tabs, searchable material grid, tool grid, live inspector.
 */

import {
  MATERIALS, MAT_COUNT, CAT, CAT_NAME, CATEGORY,
  EMPTY, SAND, WATER, WALL, WOOD, FIRE, ACID, OIL, STONE, LAVA,
} from './materials.js';
import { tool, TOOL_LIST, TOOL_BY_ID } from './tools.js';
import { G, AMBIENT, AMBIENT_DEFAULT, setAmbient } from './grid.js';
import {
  PRESETS, applyPreset, makeShareUrl, saveSlot, loadSlot, slotFilled,
  downloadScene, undo, redo, clearHistory, SLOT_COUNT,
} from './scene.js';
import { buildCodex } from './codex.js';

const $ = (id) => document.getElementById(id);

/** Number-key order, chosen for muscle memory rather than table order. */
const KEY_ORDER = [SAND, WATER, WALL, WOOD, FIRE, ACID, OIL, STONE, LAVA];
const ERASER_COLOR = '#64748b';

/** Order the categories appear in the picker. */
const GROUP_ORDER = [CAT.POWDER, CAT.LIQUID, CAT.GAS, CAT.SOLID, CAT.RIGID, CAT.ENERGY, CAT.EMITTER];

/**
 * The five shader view modes. Each carries a full label for the summary line and
 * tooltip, plus a short one so six of them fit a three-across grid on the canvas.
 */
const VIEWS = [
  ['normal', 'Normal', 'Normal'],
  ['heat', 'Heat map', 'Heat'],
  ['density', 'Density', 'Density'],
  ['charge', 'Charge', 'Charge'],
  ['chunks', 'Chunk activity', 'Chunks'],
];

/**
 * Rail glyphs, drawn with `currentColor` so the existing amber active state
 * applies for free. Deliberately not emoji: colour emoji fights the palette,
 * and on Windows it renders at a different weight from everything else.
 */
const ICONS = {
  paint: '<path d="M13.8 2.6a1.7 1.7 0 0 1 2.4 2.4L9 12.2l-3 .8.8-3z"/><path d="M3 15.5c1.6.5 3-.4 3-2"/>',
  line: '<path d="M3.5 14.5 14.5 3.5"/><circle cx="3.5" cy="14.5" r="1.2"/><circle cx="14.5" cy="3.5" r="1.2"/>',
  rect: '<rect x="3" y="4.5" width="12" height="9" rx="1"/>',
  fillrect: '<rect x="3" y="4.5" width="12" height="9" rx="1" fill="currentColor" stroke="none"/>',
  flood: '<path d="M3.8 8.6 8.4 4l5.2 5.2-4.6 4.6z"/><path d="M14.2 11.4c.9 1.2 1.3 1.9 1.3 2.4a1.3 1.3 0 0 1-2.6 0c0-.5.4-1.2 1.3-2.4z" fill="currentColor" stroke="none"/>',
  pick: '<path d="M10.8 3.6 14.4 7.2 8 13.6H4.4v-3.6z"/><path d="M12.4 2 16 5.6"/>',
  heat: '<path d="M9 2.2s3.6 3.4 3.6 6.4a3.6 3.6 0 0 1-7.2 0c0-1.5.8-2.7 1.7-3.7"/>',
  cool: '<path d="M9 2.2v13.6M3.1 5.6l11.8 6.8M14.9 5.6 3.1 12.4"/>',
  wind: '<path d="M2.5 6h7.2a2 2 0 1 0-2-2"/><path d="M2.5 10h8.8a2 2 0 1 1-2 2"/><path d="M2.5 13.8h4.6"/>',
  well: '<circle cx="9" cy="9" r="2.3"/><path d="M9 1.8v2.6m-1.3-1.3L9 1.8l1.3 1.3"/><path d="M9 16.2v-2.6m-1.3 1.3L9 16.2l1.3-1.3"/><path d="M1.8 9h2.6M3.1 7.7 1.8 9l1.3 1.3"/><path d="M16.2 9h-2.6m1.3-1.3L16.2 9l-1.3 1.3"/>',
  vacuum: '<path d="M2.6 3.6h12.8l-4.9 5.9v6l-3-1.6V9.5z"/>',
  explode: '<path d="M9 1.6l1.8 4.1 4.1-1.4-2.3 3.7 3.3 2.5-4.3.6.8 4.3L9 12.6l-3.4 2.8.8-4.3-4.3-.6 3.3-2.5L3.1 4.3l4.1 1.4z"/>',
  emitter: '<rect x="4" y="3.4" width="10" height="4" rx="1"/><path d="M6.6 10v1.6M9 10v3.4M11.4 10v1.6"/>',
};

function icon(id) {
  return '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    `stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ''}</svg>`;
}

let els = {};
let chips = [];
let toolButtons = [];
let viewButtons = [];
let ctl = null;

export function materialColor(t) {
  return t === EMPTY ? ERASER_COLOR : MATERIALS[t].colors[0];
}

export function initUI(controller) {
  ctl = controller;
  els = {
    matGroups: $('matGroups'), matSearch: $('matSearch'),
    toolRail: $('toolRail'), toolHint: $('toolHint'),
    toolName: $('toolName'), toolReach: $('toolReach'),
    brush: $('brush'), brushVal: $('brushVal'),
    scatter: $('scatter'), scatterVal: $('scatterVal'),
    shapeBtn: $('shapeBtn'), symXBtn: $('symXBtn'), symYBtn: $('symYBtn'), fsBtn: $('fsBtn'),
    viewGrid: $('viewGrid'), speed: $('speed'), speedVal: $('speedVal'),
    worldBar: $('worldBar'), worldBody: $('worldBody'), worldToggle: $('worldToggle'),
    worldSummary: $('worldSummary'), worldChevron: $('worldChevron'),
    ambient: $('ambient'), ambientVal: $('ambientVal'), ambientReset: $('ambientReset'),
    pauseBtn: $('pauseBtn'), stepBtn: $('stepBtn'), clearBtn: $('clearBtn'),
    sceneBtn: $('sceneBtn'), sceneDrawer: $('sceneDrawer'), sceneClose: $('sceneClose'),
    codexBtn: $('codexBtn'), codexModal: $('codexModal'), codexClose: $('codexClose'),
    codexBackdrop: $('codexBackdrop'), codexSearch: $('codexSearch'), codexBody: $('codexBody'),
    pausedBadge: $('pausedBadge'), ring: $('brushRing'),
    badgeIcon: $('toolBadgeIcon'), badgeName: $('toolBadgeName'), badgeMat: $('toolBadgeMat'),
    fps: $('fpsVal'), ms: $('msVal'), count: $('countVal'), part: $('partVal'),
    chunks: $('chunkVal'), grid: $('gridVal'), renderer: $('rendererVal'),
    inspDot: $('inspDot'), inspMat: $('inspMat'), inspCat: $('inspCat'),
    inspTemp: $('inspTemp'), inspCharge: $('inspCharge'), inspXY: $('inspXY'),
  };

  buildMaterialGrid();
  buildToolRail();
  buildViewGrid();
  buildSceneTab();
  buildCodexPanel();
  wireWorld();
  wireDrawer();
  wireControls();
  wireKeys();

  setBrush(tool.size);
  setScatter(Math.round(tool.scatter * 100));
  selectMaterial(tool.material);
  selectTool(tool.id);
  syncToggles();
}

/* ------------------------------ material grid ------------------------------ */

function buildMaterialGrid() {
  const frag = document.createDocumentFragment();

  const groups = new Map();
  for (let t = 1; t < MAT_COUNT; t++) {
    if (MATERIALS[t].hidden) continue;
    const c = CATEGORY[t];
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(t);
  }

  const ordered = GROUP_ORDER.filter(c => groups.has(c));
  for (const c of ordered) {
    const wrap = document.createElement('div');
    wrap.dataset.group = String(c);

    const label = document.createElement('h3');
    label.className = 'text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500 mb-1.5';
    label.textContent = CAT_NAME[c];
    wrap.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 gap-1.5';
    for (const t of groups.get(c)) grid.appendChild(makeChip(t, MATERIALS[t].name));
    wrap.appendChild(grid);
    frag.appendChild(wrap);
  }

  // eraser lives on its own at the bottom
  const wrap = document.createElement('div');
  wrap.dataset.group = 'eraser';
  const grid = document.createElement('div');
  grid.className = 'grid grid-cols-2 gap-1.5';
  grid.appendChild(makeChip(EMPTY, 'Eraser'));
  wrap.appendChild(grid);
  frag.appendChild(wrap);

  els.matGroups.appendChild(frag);
}

function makeChip(t, name) {
  const b = document.createElement('button');
  b.dataset.mat = String(t);
  b.dataset.name = name.toLowerCase();
  b.style.setProperty('--c', materialColor(t));
  b.className = 'chip flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-white/10 ' +
    'bg-white/[0.04] text-[12px] font-medium text-slate-300 hover:bg-white/[0.08] ' +
    'hover:text-white transition active:scale-[0.97] text-left';
  const dot = document.createElement('span');
  dot.className = 'dot';
  b.appendChild(dot);
  b.appendChild(document.createTextNode(name));

  const M = MATERIALS[t];
  const key = t === EMPTY ? 0 : KEY_ORDER.indexOf(t) + 1;
  b.title = t === EMPTY ? 'Eraser (0)'
    : `${name}${key > 0 ? ` (${key})` : ''}\ndensity ${M.density}` +
      `${M.meltPoint < Infinity ? `\nmelts ${M.meltPoint}C` : ''}` +
      `${M.boilPoint < Infinity ? `\nboils ${M.boilPoint}C` : ''}` +
      `${M.ignitionTemp < Infinity ? `\nignites ${M.ignitionTemp}C` : ''}` +
      `${M.conducts ? '\nconducts current' : ''}`;

  b.addEventListener('click', () => { selectMaterial(t, true); b.blur(); });
  chips.push(b);
  return b;
}

function filterMaterials(query) {
  const q = query.trim().toLowerCase();
  for (const b of chips) b.classList.toggle('hidden', q !== '' && !b.dataset.name.includes(q));
  // hide a category heading whose chips are all filtered out
  for (const group of els.matGroups.children) {
    const visible = group.querySelectorAll('button:not(.hidden)').length;
    group.classList.toggle('hidden', visible === 0);
  }
}

/** Last material reflected in the chips, so the loop can spot the eyedropper. */
let shownMat = -1;

/**
 * `fromClick` distinguishes a deliberate chip press from a programmatic sync.
 * Only a real click arms Paint — otherwise the eyedropper would switch tools out
 * from under you the moment it picked something up.
 */
export function selectMaterial(t, fromClick = false) {
  tool.material = t;
  shownMat = t;
  const s = String(t);
  for (const b of chips) b.classList.toggle('active', b.dataset.mat === s);

  // The reported trap: clicking material chips while Gravity Well was still
  // armed, and nothing painting. Arming Paint fixes it without overriding a
  // deliberate choice of Line, Flood or Emitter, which all use the material.
  if (fromClick) {
    const def = TOOL_BY_ID.get(tool.id);
    if (def && !def.material) selectTool('paint');
  }
  syncRing();
  syncBadge();
}

/** Cheap resync so a tool that sets `tool.material` itself (eyedropper) shows up. */
export function refreshMaterial() {
  if (tool.material !== shownMat) selectMaterial(tool.material);
}

/* -------------------------------- tool rail -------------------------------- */

function buildToolRail() {
  const frag = document.createDocumentFragment();
  toolButtons = TOOL_LIST.map((t) => {
    const b = document.createElement('button');
    b.dataset.tool = t.id;
    b.className = 'rail-btn';
    b.innerHTML = icon(t.id);
    b.title = `${t.name} — ${t.hint}`;
    b.setAttribute('aria-label', t.name);
    b.addEventListener('click', () => { selectTool(t.id); b.blur(); });
    frag.appendChild(b);
    return b;
  });
  els.toolRail.appendChild(frag);
}

export function selectTool(id) {
  tool.id = id;
  for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === id);
  const def = TOOL_BY_ID.get(id);
  els.toolName.textContent = def ? def.name : id;
  els.toolHint.textContent = def ? def.hint : '';
  syncRing();
  syncBadge();
}

/** Radius in cells that the armed tool actually affects. */
export function toolReach() {
  const def = TOOL_BY_ID.get(tool.id);
  return def ? def.reach(tool) : tool.size - 1;
}

/**
 * Ring style follows the TOOL, not the material: dashed means "acts on what is
 * already there", solid means "places something". Its size is the tool's true
 * reach, so the gravity well no longer draws a lie.
 */
function syncRing() {
  const def = TOOL_BY_ID.get(tool.id);
  const field = !!(def && def.field);
  els.ring.classList.toggle('field', field);
  els.ring.classList.toggle('square', !field && tool.shape === 'square');
  els.ring.style.borderColor = field ? '#7dd3fc' : materialColor(tool.material);
  els.toolReach.textContent = `r ${toolReach()}`;
}

function syncBadge() {
  const def = TOOL_BY_ID.get(tool.id);
  els.badgeIcon.innerHTML = icon(tool.id);
  els.badgeName.textContent = def ? def.name : tool.id;
  if (def && def.material) {
    const c = materialColor(tool.material);
    els.badgeMat.innerHTML = `<span class="w-2 h-2 rounded-sm" style="background:${c};box-shadow:0 0 6px ${c}"></span>` +
      (tool.material === EMPTY ? 'Eraser' : MATERIALS[tool.material].name);
    els.badgeMat.classList.remove('hidden');
  } else {
    els.badgeMat.textContent = '';
    els.badgeMat.classList.add('hidden');
  }
}

function cycleTool(dir) {
  const i = TOOL_LIST.findIndex(t => t.id === tool.id);
  const n = (i + dir + TOOL_LIST.length) % TOOL_LIST.length;
  selectTool(TOOL_LIST[n].id);
}

/* -------------------------------- view modes -------------------------------- */

function buildViewGrid() {
  const frag = document.createDocumentFragment();
  viewButtons = VIEWS.map(([id, label, short]) => {
    const b = document.createElement('button');
    b.dataset.view = id;
    b.dataset.label = label;
    b.textContent = short;
    b.title = label;
    b.className = 'tool-btn px-1 py-1 rounded-md border border-white/10 bg-white/[0.05] ' +
      'text-[11px] text-slate-300 hover:bg-white/[0.10] hover:text-white transition';
    b.addEventListener('click', () => { selectView(id); b.blur(); });
    frag.appendChild(b);
    return b;
  });
  els.viewGrid.appendChild(frag);
  selectView('normal');
}

function selectView(id) {
  for (const b of viewButtons) b.classList.toggle('active', b.dataset.view === id);
  ctl.setView(id);
  syncWorld();
}

export function currentView() {
  const b = viewButtons.find(v => v.classList.contains('active'));
  return b ? b.dataset.view : 'normal';
}

/* ------------------------------ world bar ------------------------------ */

function syncWorld() {
  const active = viewButtons.find(v => v.classList.contains('active'));
  els.worldSummary.textContent = `${active ? active.dataset.label : 'Normal'} · ${AMBIENT}°C`;
  els.ambientVal.textContent = `${AMBIENT}°C`;
  els.ambient.value = AMBIENT;
  // room temperature is the one setting whose value is worth flagging when it is
  // away from default, because everything else in the scene then behaves oddly
  els.ambientVal.classList.toggle('text-amber-300', AMBIENT === AMBIENT_DEFAULT);
  els.ambientVal.classList.toggle('text-rose-300', AMBIENT !== AMBIENT_DEFAULT);
}

/** Re-read ambient from the model — a loaded scene carries its own. */
export function refreshWorld() { syncWorld(); }

export function setWorldOpen(open) {
  els.worldBody.classList.toggle('hidden', !open);
  els.worldChevron.innerHTML = open ? '&#9662;' : '&#9656;';
}

export function worldOpen() { return !els.worldBody.classList.contains('hidden'); }

function wireWorld() {
  els.worldToggle.addEventListener('click', () => {
    setWorldOpen(!worldOpen());
    els.worldToggle.blur();
  });
  els.ambient.addEventListener('input', () => { setAmbient(+els.ambient.value); syncWorld(); });
  els.ambientReset.addEventListener('click', () => {
    setAmbient(AMBIENT_DEFAULT);
    syncWorld();
    els.ambientReset.blur();
  });
}

/* -------------------------------- scene tab -------------------------------- */

function section(title) {
  const wrap = document.createElement('div');
  const h = document.createElement('h3');
  h.className = 'text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500 mb-2';
  h.textContent = title;
  wrap.appendChild(h);
  return wrap;
}

function smallButton(label, onClick, extra = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = 'px-2 py-2 rounded-lg border border-white/10 bg-white/[0.04] text-[12px] ' +
    'text-slate-300 hover:bg-white/[0.08] hover:text-white transition active:scale-[0.97] ' + extra;
  b.addEventListener('click', () => { onClick(b); b.blur(); });
  return b;
}

function buildSceneTab() {
  const host = $('sceneExtra');

  const presets = section('Presets');
  const pgrid = document.createElement('div');
  pgrid.className = 'grid grid-cols-2 gap-1.5';
  for (const p of PRESETS) {
    pgrid.appendChild(smallButton(p.name, () => {
      ctl.beforeEdit();
      applyPreset(p.id);
    }));
  }
  presets.appendChild(pgrid);
  host.appendChild(presets);

  const history = section('History');
  const hgrid = document.createElement('div');
  hgrid.className = 'grid grid-cols-2 gap-1.5';
  hgrid.appendChild(smallButton('Undo', () => undo()));
  hgrid.appendChild(smallButton('Redo', () => redo()));
  history.appendChild(hgrid);
  host.appendChild(history);

  const slots = section('Save slots');
  const sgrid = document.createElement('div');
  sgrid.className = 'grid grid-cols-3 gap-1.5';
  const labels = [];
  for (let n = 1; n <= SLOT_COUNT; n++) {
    const b = smallButton(slotLabel(n), () => {
      // click saves, shift-click loads — keeps three slots inside six buttons
      saveSlot(n);
      b.textContent = slotLabel(n);
      flash(b, 'Saved');
    });
    b.title = `Slot ${n}: click to save, use Load below to restore`;
    labels.push(b);
    sgrid.appendChild(b);
  }
  slots.appendChild(sgrid);
  const lgrid = document.createElement('div');
  lgrid.className = 'grid grid-cols-3 gap-1.5 mt-1.5';
  for (let n = 1; n <= SLOT_COUNT; n++) {
    lgrid.appendChild(smallButton(`Load ${n}`, (b) => {
      ctl.beforeEdit();
      const r = loadSlot(n);
      if (r === 'empty') flash(b, 'Empty');
      else if (r === 'stale') flash(b, 'Old format');
    }));
  }
  slots.appendChild(lgrid);
  host.appendChild(slots);

  const share = section('Share');
  const shareGrid = document.createElement('div');
  shareGrid.className = 'grid grid-cols-2 gap-1.5';
  shareGrid.appendChild(smallButton('Copy link', async (b) => {
    const { url, bytes } = await makeShareUrl();
    location.hash = url.split('#')[1];
    try {
      await navigator.clipboard.writeText(url);
      flash(b, `Copied ${(bytes / 1024).toFixed(1)}kB`);
    } catch {
      flash(b, 'In address bar');
    }
  }));
  shareGrid.appendChild(smallButton('Download', () => downloadScene()));
  share.appendChild(shareGrid);
  host.appendChild(share);

  function slotLabel(n) { return slotFilled(n) ? `Save ${n} •` : `Save ${n}`; }
}

function flash(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

/* --------------------------------- wiring --------------------------------- */

export function setDrawer(open) {
  els.sceneDrawer.classList.toggle('hidden', !open);
  els.sceneDrawer.classList.toggle('flex', open);
}

export function drawerOpen() { return !els.sceneDrawer.classList.contains('hidden'); }

function wireDrawer() {
  els.sceneBtn.addEventListener('click', () => { setDrawer(true); els.sceneBtn.blur(); });
  els.sceneClose.addEventListener('click', () => { setDrawer(false); });
  els.codexBtn.addEventListener('click', () => { setCodex(true); els.codexBtn.blur(); });
  els.codexClose.addEventListener('click', () => setCodex(false));
  els.codexBackdrop.addEventListener('click', () => setCodex(false));
  els.codexSearch.addEventListener('input', () => filterCodex(els.codexSearch.value));
}

/* --------------------------------- codex --------------------------------- */

let codexEntries = [];

function buildCodexPanel() {
  const frag = document.createDocumentFragment();
  codexEntries = [];

  for (const section of buildCodex()) {
    if (section.entries.length === 0) continue;
    const wrap = document.createElement('section');

    const h = document.createElement('h3');
    h.className = 'text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500 mb-2';
    h.textContent = section.generated
      ? `${section.group} · ${section.entries.length}`
      : section.group;
    wrap.appendChild(h);

    const list = document.createElement('div');
    list.className = 'flex flex-col gap-1.5';
    for (const e of section.entries) {
      const row = document.createElement('div');
      row.className = 'rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2';

      const t = document.createElement('div');
      t.className = 'flex items-center gap-2 text-[13px] font-semibold text-slate-100';
      for (const m of e.mats) {
        if (m === EMPTY) continue;
        const dot = document.createElement('span');
        dot.className = 'w-2 h-2 rounded-sm shrink-0';
        const c = materialColor(m);
        dot.style.cssText = `background:${c};box-shadow:0 0 6px ${c}`;
        t.appendChild(dot);
      }
      t.appendChild(document.createTextNode(e.title));

      const d = document.createElement('p');
      d.className = 'mt-0.5 text-[11px] leading-snug text-slate-400';
      d.textContent = e.detail;

      row.appendChild(t);
      row.appendChild(d);
      // searched as one lowercase blob: names, temperatures and prose all match
      row.dataset.q = `${e.title} ${e.detail}`.toLowerCase();
      list.appendChild(row);
      codexEntries.push(row);
    }

    wrap.appendChild(list);
    frag.appendChild(wrap);
  }
  els.codexBody.appendChild(frag);
}

function filterCodex(query) {
  const q = query.trim().toLowerCase();
  for (const row of codexEntries) {
    row.classList.toggle('hidden', q !== '' && !row.dataset.q.includes(q));
  }
  for (const section of els.codexBody.children) {
    const visible = section.querySelectorAll('[data-q]:not(.hidden)').length;
    section.classList.toggle('hidden', visible === 0);
  }
}

export function setCodex(open) {
  els.codexModal.classList.toggle('hidden', !open);
  els.codexModal.classList.toggle('flex', open);
  if (open) els.codexSearch.focus();
}

export function codexOpen() { return !els.codexModal.classList.contains('hidden'); }

/** Number of rendered entries per section, for the parity self-check. */
export function codexSectionCounts() {
  const out = {};
  for (const section of buildCodex()) out[section.group] = section.entries.length;
  return out;
}

function wireControls() {
  els.matSearch.addEventListener('input', () => filterMaterials(els.matSearch.value));
  els.brush.addEventListener('input', () => setBrush(+els.brush.value));
  els.scatter.addEventListener('input', () => setScatter(+els.scatter.value));
  els.speed.addEventListener('input', () => {
    const v = +els.speed.value / 100;
    els.speedVal.textContent = v.toFixed(2).replace(/0$/, '') + '×';
    ctl.setSpeed(v);
  });

  els.shapeBtn.addEventListener('click', () => {
    tool.shape = tool.shape === 'circle' ? 'square' : 'circle';
    syncToggles(); els.shapeBtn.blur();
  });
  els.symXBtn.addEventListener('click', () => { tool.symX = !tool.symX; syncToggles(); els.symXBtn.blur(); });
  els.symYBtn.addEventListener('click', () => { tool.symY = !tool.symY; syncToggles(); els.symYBtn.blur(); });
  els.fsBtn.addEventListener('click', () => { toggleFullscreen(); els.fsBtn.blur(); });

  els.pauseBtn.addEventListener('click', () => { ctl.togglePause(); els.pauseBtn.blur(); });
  els.stepBtn.addEventListener('click', () => { ctl.step(); els.stepBtn.blur(); });
  els.clearBtn.addEventListener('click', () => { ctl.clear(); els.clearBtn.blur(); });
}

function toggleFullscreen() {
  document.body.classList.toggle('fullscreen');
  window.dispatchEvent(new Event('resize'));
}

function wireKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // Escape has to work while typing, or the guide traps you: it focuses its
    // own search box on open, so every other key is correctly swallowed.
    if (e.key === 'Escape') {
      if (codexOpen()) setCodex(false);
      else if (drawerOpen()) setDrawer(false);
      else if (typing) e.target.blur();
      return;
    }
    if (typing) return;
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      return;
    }
    if (e.altKey) return;

    switch (e.key) {
      case '?': setCodex(!codexOpen()); return;
      case ' ': e.preventDefault(); ctl.togglePause(); return;
      case '.': ctl.step(); return;
      case '[': setBrush(tool.size - 1); return;
      case ']': setBrush(tool.size + 1); return;
      case 'q': case 'Q': cycleTool(-1); return;
      case 'e': case 'E': cycleTool(1); return;
      case 'x': case 'X': tool.symX = !tool.symX; syncToggles(); return;
      case 'y': case 'Y': tool.symY = !tool.symY; syncToggles(); return;
      case 'f': case 'F': toggleFullscreen(); return;
      case 'c': case 'C': ctl.clear(); return;
      case '0': selectMaterial(EMPTY); return;
      case 'z': case 'Z': undo(); return;
      case 'r': case 'R': redo(); return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const t = KEY_ORDER[+e.key - 1];
      if (t !== undefined) selectMaterial(t);
    }
  });
}

export function setBrush(v) {
  tool.size = Math.max(1, Math.min(16, v | 0));
  els.brush.value = tool.size;
  els.brushVal.textContent = tool.size;
  syncRing();               // the well's radius rides on size, so the ring must follow
}

function setScatter(pct) {
  tool.scatter = Math.max(0.1, Math.min(1, pct / 100));
  els.scatter.value = pct;
  els.scatterVal.textContent = pct + '%';
}

function syncToggles() {
  els.shapeBtn.textContent = tool.shape === 'circle' ? 'Circle' : 'Square';
  els.symXBtn.classList.toggle('tool-btn', true);
  els.symXBtn.classList.toggle('active', tool.symX);
  els.symYBtn.classList.toggle('tool-btn', true);
  els.symYBtn.classList.toggle('active', tool.symY);
  syncRing();
}

export function syncPaused(paused) {
  els.pauseBtn.innerHTML = paused ? '&#9654;' : '&#10074;&#10074;';
  els.pausedBadge.classList.toggle('hidden', !paused);
}

/* -------------------------------- readouts -------------------------------- */

export function setStats(s) {
  els.fps.textContent = s.fps;
  els.ms.textContent = s.ms;
  els.count.textContent = s.count;
  els.part.textContent = s.particles;
  els.chunks.textContent = s.chunks;
  els.grid.innerHTML = `${s.w} &times; ${s.h}`;
  els.renderer.textContent = s.renderer;
}

/** Reads the cell directly so the panel can never disagree with the grid. */
export function setInspector(x, y, inside) {
  // The pointer coords were clamped against the grid as it was when the event
  // fired. A window resize reallocates the grid smaller, so by the next frame
  // they can point past the end — one guard here rather than at every caller.
  if (inside && (x < 0 || y < 0 || x >= G.w || y >= G.h)) inside = false;
  if (!inside) {
    els.inspMat.textContent = '—';
    els.inspCat.textContent = '—';
    els.inspTemp.textContent = '—';
    els.inspCharge.textContent = '—';
    els.inspXY.textContent = '—';
    els.inspDot.style.background = '#334155';
    return;
  }
  const i = y * G.w + x;
  const t = G.mat[i];
  els.inspMat.textContent = MATERIALS[t].name;
  els.inspCat.textContent = CAT_NAME[CATEGORY[t]] || '—';
  els.inspTemp.textContent = `${G.temp[i].toFixed(0)}°C`;
  els.inspCharge.textContent = String(G.charge[i]);
  els.inspXY.textContent = `${x},${y}`;
  els.inspDot.style.background = t === EMPTY ? '#334155' : MATERIALS[t].colors[0];
}
