/**
 * Rendering.
 *
 * Two interchangeable implementations behind one `{ kind, resize, draw }`
 * interface. The WebGL2 path uploads the simulation's typed arrays directly as
 * textures — no CPU-side pixel packing at all — and does palette lookup,
 * blackbody glow and bloom on the GPU. The Canvas2D path is the fallback.
 */

import { G, CHUNK } from './grid.js';
import { PALETTE_U32, PALETTE_RGBA, MAT_COUNT, DENSITY, EMPTY } from './materials.js';
import { VERT_FULLSCREEN, FRAG_SCENE, FRAG_BLUR, FRAG_COMPOSITE } from './shaders.js';

export const VIEW = {
  NORMAL: 'normal', CHUNKS: 'chunks', HEAT: 'heat', DENSITY: 'density', CHARGE: 'charge',
};
const VIEW_INDEX = { normal: 0, chunks: 1, heat: 2, density: 3, charge: 4 };

const BLOOM_STRENGTH = 1.15;

/** Prefers WebGL2, falls back to Canvas2D. `prefer` can force either path. */
export function createRenderer(canvas, prefer) {
  if (prefer !== 'canvas2d') {
    try {
      const r = createWebGLRenderer(canvas);
      if (r) return r;
      console.warn('WebGL2 unavailable, using the Canvas2D renderer.');
    } catch (e) {
      console.warn('WebGL2 renderer failed to initialise, using Canvas2D:', e.message);
    }
  }
  return createCanvas2DRenderer(canvas);
}

/* ============================== Canvas2D ============================== */

/** Same blue -> cyan -> yellow -> red ramp the shader uses, for the fallback. */
const DEBUG_EMPTY = packRGB(5, 5, 8);

function packRGB(r, g, b) {
  const LE = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;
  return LE ? (((255 << 24) | (b << 16) | (g << 8) | r) >>> 0)
            : (((r << 24) | (g << 16) | (b << 8) | 255) >>> 0);
}

function rampU32(v) {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  let r, g, b;
  if (v < 0.35) { const t = v / 0.35; r = 13 + t * 13; g = 26 + t * 165; b = 89 + t * 128; }
  else if (v < 0.7) { const t = (v - 0.35) / 0.35; r = 26 + t * 216; g = 191 + t * 26; b = 217 - t * 166; }
  else { const t = (v - 0.7) / 0.3; r = 242 + t * 13; g = 217 - t * 166; b = 51 - t * 26; }
  return packRGB(r | 0, g | 0, b | 0);
}

export function createCanvas2DRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let img = null, px = null;

  function drawChunkOverlay() {
    const { cw, ch, w, h, active } = G;
    ctx.save();
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const x = cx * CHUNK, y = cy * CHUNK;
        const cwid = Math.min(CHUNK, w - x), chgt = Math.min(CHUNK, h - y);
        if (active[cy * cw + cx]) {
          ctx.fillStyle = 'rgba(74, 222, 128, 0.16)';
          ctx.fillRect(x, y, cwid, chgt);
        }
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cwid - 1, chgt - 1);
      }
    }
    ctx.restore();
  }

  return {
    kind: 'canvas2d',
    resize(w, h) {
      canvas.width = w;
      canvas.height = h;
      img = ctx.createImageData(w, h);
      px = new Uint32Array(img.data.buffer);
    },
    draw(mode) {
      const mat = G.mat, shade = G.shade, n = G.n;
      if (mode === VIEW.HEAT || mode === VIEW.DENSITY || mode === VIEW.CHARGE) {
        for (let i = 0; i < n; i++) {
          let v;
          if (mode === VIEW.HEAT) v = (G.temp[i] - 20) / 1200;
          else if (mode === VIEW.DENSITY) v = mat[i] === EMPTY ? -1 : DENSITY[mat[i]] / 8000;
          else v = mat[i] === EMPTY ? -1 : G.charge[i] / 255;
          px[i] = v < 0 ? DEBUG_EMPTY : rampU32(v);
        }
      } else {
        for (let i = 0; i < n; i++) px[i] = PALETTE_U32[(mat[i] << 2) | shade[i]];
      }
      ctx.putImageData(img, 0, 0);
      if (mode === VIEW.CHUNKS) drawChunkOverlay();
    },
    dispose() {},
  };
}

/* =============================== WebGL2 =============================== */

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl, fragSrc) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERT_FULLSCREEN);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  return p;
}

function makeTexture(gl, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Colour-only framebuffer with `count` RGBA8 attachments. */
function makeTarget(gl, w, h, count, filter) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const textures = [];
  const buffers = [];
  for (let i = 0; i < count; i++) {
    const tex = makeTexture(gl, Array.isArray(filter) ? filter[i] : filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
    textures.push(tex);
    buffers.push(gl.COLOR_ATTACHMENT0 + i);
  }
  gl.drawBuffers(buffers);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`framebuffer incomplete (0x${status.toString(16)}) at ${w}x${h}`);
  }
  return { fbo, textures, buffers, w, h };
}

function createWebGLRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, powerPreference: 'high-performance',
  });
  if (!gl) return null;

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.bindVertexArray(gl.createVertexArray());   // WebGL2 requires a bound VAO to draw

  const progScene = link(gl, FRAG_SCENE);
  const progBlur = link(gl, FRAG_BLUR);
  const progComposite = link(gl, FRAG_COMPOSITE);

  const u = {
    scene: {
      mat: gl.getUniformLocation(progScene, 'uMat'),
      shade: gl.getUniformLocation(progScene, 'uShade'),
      charge: gl.getUniformLocation(progScene, 'uCharge'),
      temp: gl.getUniformLocation(progScene, 'uTemp'),
      palette: gl.getUniformLocation(progScene, 'uPalette'),
      info: gl.getUniformLocation(progScene, 'uInfo'),
      grid: gl.getUniformLocation(progScene, 'uGrid'),
      viewMode: gl.getUniformLocation(progScene, 'uViewMode'),
    },
    blur: {
      src: gl.getUniformLocation(progBlur, 'uSrc'),
      step: gl.getUniformLocation(progBlur, 'uStep'),
    },
    composite: {
      base: gl.getUniformLocation(progComposite, 'uBase'),
      bloom: gl.getUniformLocation(progComposite, 'uBloom'),
      chunks: gl.getUniformLocation(progComposite, 'uChunks'),
      strength: gl.getUniformLocation(progComposite, 'uBloomStrength'),
      viewMode: gl.getUniformLocation(progComposite, 'uViewMode'),
      grid: gl.getUniformLocation(progComposite, 'uGrid'),
      chunkSize: gl.getUniformLocation(progComposite, 'uChunkSize'),
    },
  };

  // palette never changes, so it uploads once
  const palTex = makeTexture(gl, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, MAT_COUNT * 4, 1, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, PALETTE_RGBA);

  // per-material constants the shader needs for the density view
  const infoTex = makeTexture(gl, gl.NEAREST);
  const info = new Uint8Array(MAT_COUNT * 4);
  for (let t = 0; t < MAT_COUNT; t++) {
    info[t * 4] = Math.round(Math.min(1, DENSITY[t] / 8000) * 255);
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, MAT_COUNT, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, info);

  const matTex = makeTexture(gl, gl.NEAREST);
  const shadeTex = makeTexture(gl, gl.NEAREST);
  const tempTex = makeTexture(gl, gl.NEAREST);
  const chargeTex = makeTexture(gl, gl.NEAREST);
  const chunkTex = makeTexture(gl, gl.NEAREST);

  let scene = null, bloomA = null, bloomB = null;
  let w = 0, h = 0, cw = 0, ch = 0;
  let uploadedTempVersion = -1;

  function allocGrid(nw, nh) {
    w = nw; h = nh;
    gl.bindTexture(gl.TEXTURE_2D, matTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, shadeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, tempTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, chargeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null);
    uploadedTempVersion = -1;   // new storage, so the next draw must re-upload
  }

  function allocChunks(ncw, nch) {
    cw = ncw; ch = nch;
    gl.bindTexture(gl.TEXTURE_2D, chunkTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, cw, ch, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null);
  }

  function bind(unit, tex, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  function blurPass(target, srcTex, dx, dy) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(progBlur);
    bind(0, srcTex, u.blur.src);
    gl.uniform2f(u.blur.step, dx, dy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    kind: 'webgl2',

    resize(nw, nh) {
      canvas.width = nw;
      canvas.height = nh;
      allocGrid(nw, nh);
      allocChunks(Math.ceil(nw / CHUNK), Math.ceil(nh / CHUNK));

      for (const t of [scene, bloomA, bloomB]) {
        if (!t) continue;
        gl.deleteFramebuffer(t.fbo);
        for (const tex of t.textures) gl.deleteTexture(tex);
      }
      const hw = Math.max(1, nw >> 1), hh = Math.max(1, nh >> 1);
      // attachment 0 is sampled 1:1 (NEAREST, stays crisp); attachment 1 is
      // downsampled into the bloom chain, so it wants LINEAR averaging
      scene = makeTarget(gl, nw, nh, 2, [gl.NEAREST, gl.LINEAR]);
      bloomA = makeTarget(gl, hw, hh, 1, gl.LINEAR);
      bloomB = makeTarget(gl, hw, hh, 1, gl.LINEAR);
    },

    draw(mode) {
      if (G.w !== w || G.h !== h) return;   // resize lands next frame

      // upload straight from the simulation arrays: no packing pass
      gl.bindTexture(gl.TEXTURE_2D, matTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, G.mat);
      gl.bindTexture(gl.TEXTURE_2D, shadeTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, G.shade);
      if (uploadedTempVersion !== G.tempVersion) {
        gl.bindTexture(gl.TEXTURE_2D, tempTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, G.temp);
        uploadedTempVersion = G.tempVersion;
      }
      if (mode === VIEW.CHUNKS) {
        gl.bindTexture(gl.TEXTURE_2D, chunkTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cw, ch, gl.RED_INTEGER, gl.UNSIGNED_BYTE, G.active);
      }
      // charge only matters to the shader in its own debug view
      if (mode === VIEW.CHARGE) {
        gl.bindTexture(gl.TEXTURE_2D, chargeTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, G.charge);
      }

      // 1. scene -> base colour + emissive colour
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      gl.viewport(0, 0, w, h);
      gl.drawBuffers(scene.buffers);
      gl.useProgram(progScene);
      bind(0, matTex, u.scene.mat);
      bind(1, shadeTex, u.scene.shade);
      bind(2, tempTex, u.scene.temp);
      bind(3, palTex, u.scene.palette);
      bind(4, chargeTex, u.scene.charge);
      bind(5, infoTex, u.scene.info);
      gl.uniform2i(u.scene.grid, w, h);
      gl.uniform1i(u.scene.viewMode, VIEW_INDEX[mode] || 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. two-pass separable blur of the emissive attachment, at half resolution
      blurPass(bloomA, scene.textures[1], 1 / bloomA.w, 0);
      blurPass(bloomB, bloomA.textures[0], 0, 1 / bloomB.h);

      // 3. composite to the screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progComposite);
      bind(0, scene.textures[0], u.composite.base);
      bind(1, bloomB.textures[0], u.composite.bloom);
      bind(2, chunkTex, u.composite.chunks);
      gl.uniform1f(u.composite.strength, BLOOM_STRENGTH);
      gl.uniform1i(u.composite.viewMode, mode === VIEW.CHUNKS ? 1 : 0);
      gl.uniform2i(u.composite.grid, w, h);
      gl.uniform1i(u.composite.chunkSize, CHUNK);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    dispose() {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    },
  };
}
