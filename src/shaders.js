/**
 * GLSL ES 3.00 sources for the WebGL2 render path.
 *
 * Every pass draws the same attribute-less fullscreen triangle, so there are no
 * vertex buffers anywhere in the renderer.
 */

export const VERT_FULLSCREEN = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Scene pass. Reads the material and shade grids as integer textures uploaded
 * straight from the simulation's own typed arrays (no CPU-side packing), looks
 * the colour up in the palette, mixes in a blackbody glow for hot cells, and
 * writes base colour and emissive colour to two attachments at once.
 */
export const FRAG_SCENE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

uniform usampler2D uMat;
uniform usampler2D uShade;
uniform usampler2D uCharge;
uniform sampler2D uTemp;
uniform sampler2D uPalette;
uniform sampler2D uInfo;        // per-material data: R = density, normalised
uniform ivec2 uGrid;
uniform int uViewMode;          // 0 normal, 1 chunks, 2 heat, 3 density, 4 charge

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmissive;

/**
 * Cheap blackbody ramp: dull red at ~500C through orange and yellow to a
 * white-hot core by ~2500C. Not physically calibrated, just monotonic and
 * plausible to the eye.
 */
vec3 blackbody(float t) {
  float k = clamp((t - 500.0) / 2000.0, 0.0, 1.0);
  vec3 dull  = vec3(0.65, 0.09, 0.02);
  vec3 mid   = vec3(1.00, 0.45, 0.05);
  vec3 hot   = vec3(1.00, 0.92, 0.70);
  vec3 c = mix(dull, mid, smoothstep(0.0, 0.45, k));
  return mix(c, hot, smoothstep(0.45, 1.0, k));
}

/** Blue -> cyan -> yellow -> red ramp for the scalar debug views. */
vec3 rampFor(float v) {
  v = clamp(v, 0.0, 1.0);
  vec3 c = mix(vec3(0.05, 0.10, 0.35), vec3(0.10, 0.75, 0.85), smoothstep(0.0, 0.35, v));
  c = mix(c, vec3(0.95, 0.85, 0.20), smoothstep(0.35, 0.70, v));
  return mix(c, vec3(1.00, 0.20, 0.10), smoothstep(0.70, 1.0, v));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = uGrid.y - 1 - p.y;              // sim rows run top-down, GL runs bottom-up

  uint m = texelFetch(uMat, p, 0).r;
  uint s = texelFetch(uShade, p, 0).r;

  // debug views replace the palette entirely and never feed the bloom pass
  if (uViewMode >= 2) {
    float v = 0.0;
    if (uViewMode == 2) {
      v = (texelFetch(uTemp, p, 0).r - 20.0) / 1200.0;
    } else if (uViewMode == 3) {
      v = (m == 0u) ? 0.0 : texelFetch(uInfo, ivec2(int(m), 0), 0).r;
    } else {
      v = float(texelFetch(uCharge, p, 0).r) / 255.0;
    }
    vec3 dbg = (m == 0u && uViewMode != 2) ? vec3(0.02, 0.02, 0.03) : rampFor(v);
    oColor = vec4(dbg, 1.0);
    oEmissive = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec4 pal = texelFetch(uPalette, ivec2(int(m) * 4 + int(s), 0), 0);

  vec3 col = pal.rgb;
  float emis = pal.a;                   // emissive strength rides in palette alpha

  // hot cells glow regardless of what they are made of
  float temp = texelFetch(uTemp, p, 0).r;
  float glow = (m == 0u) ? 0.0 : smoothstep(500.0, 1200.0, temp);
  if (glow > 0.0) {
    col = mix(col, blackbody(temp), glow);
    emis = max(emis, glow);
  }

  oColor = vec4(col, 1.0);
  oEmissive = vec4(col * emis, 1.0);
}`;

/** Separable gaussian blur, run once horizontally and once vertically. */
export const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uStep;                     // texel size along the blur axis
out vec4 oColor;

const float W0 = 0.2270270270;
const float W1 = 0.1945945946;
const float W2 = 0.1216216216;
const float W3 = 0.0540540541;
const float W4 = 0.0162162162;

void main() {
  vec3 c = texture(uSrc, vUV).rgb * W0;
  c += texture(uSrc, vUV + uStep * 1.0).rgb * W1;
  c += texture(uSrc, vUV - uStep * 1.0).rgb * W1;
  c += texture(uSrc, vUV + uStep * 2.0).rgb * W2;
  c += texture(uSrc, vUV - uStep * 2.0).rgb * W2;
  c += texture(uSrc, vUV + uStep * 3.0).rgb * W3;
  c += texture(uSrc, vUV - uStep * 3.0).rgb * W3;
  c += texture(uSrc, vUV + uStep * 4.0).rgb * W4;
  c += texture(uSrc, vUV - uStep * 4.0).rgb * W4;
  oColor = vec4(c, 1.0);
}`;

/**
 * Composite. Base colour is sampled 1:1 with NEAREST so the pixel grid stays
 * crisp; bloom is sampled with LINEAR from a half-resolution target so the glow
 * is smooth despite being computed cheaply.
 */
export const FRAG_COMPOSITE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
in vec2 vUV;

uniform sampler2D uBase;
uniform sampler2D uBloom;
uniform usampler2D uChunks;
uniform float uBloomStrength;
uniform int uViewMode;                  // 0 = normal, 1 = chunk activity
uniform ivec2 uGrid;
uniform int uChunkSize;

out vec4 oColor;

void main() {
  vec3 base = texture(uBase, vUV).rgb;
  vec3 bloom = texture(uBloom, vUV).rgb;
  vec3 col = base + bloom * uBloomStrength;

  if (uViewMode == 1) {
    ivec2 sim = ivec2(vUV.x * float(uGrid.x), (1.0 - vUV.y) * float(uGrid.y));
    ivec2 c = sim / uChunkSize;
    if (texelFetch(uChunks, c, 0).r != 0u) col += vec3(0.06, 0.20, 0.10);
    if (sim.x % uChunkSize == 0 || sim.y % uChunkSize == 0) col += vec3(0.10, 0.11, 0.13);
  }

  oColor = vec4(col, 1.0);
}`;
