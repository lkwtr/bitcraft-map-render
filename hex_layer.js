// MapLibre custom WebGL layer that renders the entire BitCraft world as a
// single full-screen quad. The fragment shader does per-pixel inverse-Voronoi
// to find which hex each screen pixel belongs to, samples the data texture for
// raw RGB color (matching the game's _DataTexture sampling), and optionally
// applies elevation-based modulation matching the decompiled game shader.
//
// Inputs (passed in the constructor):
//   meta             — world_meta.json (bounds, grid size, IR/OR)
//   biomes           — biomes.json (legend metadata only, not used for render)
//   dataTextureUrl   — URL of world_data.png  (R,G,B=color, A=landtype)
//   elevTextureUrl   — URL of world_elev.png  (R=elevation_u8)  [optional]
//
// Per-frame controls (set with `layer.setOption(key, value)`):
//   showChunks       — bool, draw 32-small-hex chunk grid
//   showRegions      — bool, draw 2560-small-hex region borders

const VERT_SRC = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
in vec2 a_pos;        // MapLibre Mercator coord (0..1)
in vec2 a_world;      // World pixel-space coord (used for hex math)
out vec2 v_world;
void main() {
  v_world = a_world;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_world;
out vec4 outColor;

uniform sampler2D u_data;      // RGBA: R,G,B=raw hex color, A=255 (opaque)
uniform sampler2D u_elev;      // RGBA: R=elevation_u8, G=land_type (0..6)
uniform vec2  u_data_size;     // (cols, rows) of data texture
uniform float u_IR;
uniform float u_OR;

// Game shader constants (from disassembled Map/TerrainGlobalMap, sub3 PS):
//   _ElevationLightingMultiplierMax = 0.045
//   _UnderwaterColorPower            = 1.25
//   _TerrainColorSoftener            = 0.015
//   _OutlineColor                    = (0.106, 0.125, 0.141)
//   _OutlineThickness                = 10.0 game world units (== 0.125 * OR for us)
uniform float u_elev_mult;       // ~0.045
uniform float u_underwater_pow;  // ~1.25
uniform float u_soften;          // ~0.015
uniform bool  u_use_elev;        // toggle elevation modulation
uniform bool  u_show_coast;      // toggle coast outline
uniform float u_coast_thickness; // world-space thickness of the coast outline
uniform vec3  u_coast_color;     // luminance grey of OutlineColor by default

// Toggles
uniform bool  u_show_chunks;
uniform bool  u_show_regions;
uniform int   u_debug;         // 0=normal, 1=magenta solid, 2=v_world as color

// Chunk/region grid alignment offset (in SMALL-hex offset units).
//   positive x → grid shifts east   |   negative x → west
//   positive y → grid shifts north  |   negative y → south
uniform vec2  u_grid_offset;

// Large-hex grid offset (in WORLD pixel units). The large hex grid is purely
// visual; its position relative to the real small-hex (game) grid can be
// fractional. Subtracted from world position before the data-texture lookup.
uniform vec2  u_large_hex_offset_world;

// ---- Inverse hex transform: world pixel xy -> (ax, az) axial ----
vec2 worldToAxial(vec2 p) {
  float x = p.x / (u_IR * 2.0);
  float y = -x;
  float offset = p.y / (u_OR * 3.0);
  x -= offset;
  y -= offset;

  float ix = floor(x + 0.5);
  float iy = floor(y + 0.5);
  float iz = floor(-x - y + 0.5);

  if (abs(ix + iy + iz) > 0.5) {
    float dx = abs(x - ix);
    float dy = abs(y - iy);
    float dz = abs(-x - y - iz);
    if (dx > dy && dx > dz) ix = -iy - iz;
    else if (dz > dy)        iz = -ix - iy;
  }
  return vec2(ix, iz);   // (ax, az)
}

// ---- Axial -> offset (col, row) ----
vec2 axialToOffset(vec2 a) {
  return vec2(a.x + floor(a.y / 2.0), a.y);
}

// ---- Axial -> world pixel-space hex centre (pointy-top). ----
vec2 axialToWorld(vec2 a) {
  return vec2((2.0 * a.x + a.y) * u_IR, 1.5 * a.y * u_OR);
}

// 6 axial neighbours of a hex, in the same order the game shader scans them.
const vec2 AX_NEIGHBOURS[6] = vec2[6](
  vec2( 1.0,  0.0),
  vec2( 0.0,  1.0),
  vec2(-1.0,  1.0),
  vec2(-1.0,  0.0),
  vec2( 0.0, -1.0),
  vec2( 1.0, -1.0)
);

const int LT_OCEAN = 2;
const float SQRT3_2 = 0.8660254;

// (col, row) → UV. The data textures are NOT upsampled — .gwm row N occupies
// texel row (N * √3/2). This matches the game's own texture layout exactly,
// avoiding the ±1-hex artefact our previous nearest-neighbour upsample caused
// at biome boundaries.
vec2 offsetToUV(vec2 off) {
  return vec2(
    (off.x + 0.5) / u_data_size.x,
    (off.y * SQRT3_2 + 0.5) / u_data_size.y);
}

// Sample a single hex's land_type by axial coords. Returns -1 for out-of-bounds.
int sampleLandTypeAxial(vec2 a) {
  vec2 off = axialToOffset(a);
  float src_y = off.y * SQRT3_2;
  if (off.x < 0.0 || off.x >= u_data_size.x ||
      src_y < 0.0 || src_y >= u_data_size.y) return -1;
  return int(floor(texture(u_elev, offsetToUV(off)).g * 255.0 + 0.5));
}

void main() {
  // ---- Debug modes (set via ?debug=1 / ?debug=2 in URL) ---------------
  if (u_debug == 1) { outColor = vec4(1.0, 0.25, 0.6, 1.0); return; }
  if (u_debug == 2) {
    // Show v_world.x and .y mapped to colour
    outColor = vec4(
      fract(v_world.x / 1000.0),
      fract(v_world.y / 1000.0),
      0.2, 1.0);
    return;
  }

  vec2 world = v_world;

  // Which large hex are we in? (Large hex grid is shifted by u_large_hex_offset
  // relative to the small-hex coordinate frame, which is the real game grid.)
  vec2 world_large = world - u_large_hex_offset_world;
  vec2 ax  = worldToAxial(world_large);
  vec2 off = axialToOffset(ax);

  // Out of bounds → fully transparent. The compressed-row layout means the
  // valid src_y range is [0, u_data_size.y), driven by off.y * √3/2.
  float src_y = off.y * SQRT3_2;
  bool oob = (off.x < 0.0 || off.x >= u_data_size.x ||
              src_y < 0.0 || src_y >= u_data_size.y);

  vec2 uv = offsetToUV(off);
  vec4 meta = oob ? vec4(0.0) : texture(u_elev, uv);
  int land_type = int(floor(meta.g * 255.0 + 0.5));

  // Empty hex (matches game shader: landtype <= 0 → fully transparent).
  if (oob || land_type == 0) {
    outColor = vec4(0.0);
    return;
  }

  vec3 colour = texture(u_data, uv).rgb;

  // Elevation modulation, matching the disassembled game shader.
  //   Stored elevation is in [0, 1] with sea level ≈ 0.5. Convert to [-1, +1]:
  //   elev = sample * 2 - 1.
  //   Underwater (elev < 0):  c *= min(1, pow(elev+1, u_elev_mult))
  //   Above water (elev ≥ 0): c  = mix(c, white,
  //                                    min(u_soften, 1 - pow(1-elev, u_underwater_pow)))
  if (u_use_elev) {
    float elev = clamp(meta.r * 2.0 - 1.0, -1.0, 1.0);

    float darken    = min(1.0, pow(elev + 1.0, u_elev_mult));
    float brighten  = clamp(1.0 - pow(1.0 - elev, u_underwater_pow), 0.0, u_soften);

    vec3 cUnder = colour * darken;
    vec3 cAbove = mix(colour, vec3(1.0), brighten);
    colour = (elev >= 0.0) ? cAbove : cUnder;
  }

  // ---- Coast outline (matching the game shader) -----------------------
  // For non-Ocean hexes, check each of 6 axial neighbours. If a neighbour is
  // Ocean, draw a thin grey strip along the shared edge — on the LAND side.
  //
  // The shared edge between two hex centres lies on the perpendicular bisector
  // of the line connecting them, so the signed distance from a pixel to that
  // edge is dot(pixel - midpoint, normalize(thisCenter - neighbourCenter)).
  if (u_show_coast && land_type != LT_OCEAN) {
    vec2 thisCentre = axialToWorld(ax);
    for (int i = 0; i < 6; ++i) {
      vec2 nax = ax + AX_NEIGHBOURS[i];
      int nLT = sampleLandTypeAxial(nax);
      if (nLT != LT_OCEAN) continue;

      vec2 nCentre = axialToWorld(nax);
      vec2 dC      = thisCentre - nCentre;
      vec2 ndC     = dC / max(length(dC), 1e-6);
      vec2 mid     = (thisCentre + nCentre) * 0.5;
      float signedDist = dot(world_large - mid, ndC);

      // Anti-aliased blend across a 1-pixel feather around the threshold.
      float feather = max(fwidth(world_large.x) + fwidth(world_large.y), 1e-5) * 0.5;
      float t = smoothstep(u_coast_thickness + feather, u_coast_thickness - feather, signedDist)
              * step(0.0, signedDist);
      if (t > 0.0) {
        colour = mix(colour, u_coast_color, t);
        break;
      }
    }
  }

  // ---- Optional grids -------------------------------------------------
  // The grid lines are drawn using signed-distance to chunk / region edges
  // in axial space. Anti-alias against screen-space derivatives — this is
  // pixel-perfect and stable across frames (no per-frame recomputation).
  float aa = max(fwidth(world.x) + fwidth(world.y), 1e-5) * 0.6;

  if (u_show_chunks || u_show_regions) {
    // Chunks and regions are aligned to the SMALL-hex grid in BitCraft, not
    // the large-hex grid stored in our data texture. One large hex ≈ 3.2 small
    // hexes, one chunk = 32 small hexes (= 10 large hexes), one region = 2560
    // small hexes (= 800 large hexes). The boundary therefore zig-zags along
    // small-hex edges — three times finer than the large-hex grid.
    //
    // We compute small-hex axial/offset coords from the SAME world position
    // by scaling the radii. All the parity-aware masking we use for large
    // hexes carries over verbatim, just using small-hex values.
    float kSmall = 3.2;
    float sIR    = u_IR / kSmall;
    float sOR    = u_OR / kSmall;

    // World → small-hex axial (same inverse-Voronoi math, smaller radii).
    float sx_ = world.x / (sIR * 2.0);
    float sy_ = -sx_;
    float sof = world.y / (sOR * 3.0);
    sx_ -= sof; sy_ -= sof;
    float sIx = floor(sx_ + 0.5);
    float sIy = floor(sy_ + 0.5);
    float sIz = floor(-sx_ - sy_ + 0.5);
    if (abs(sIx + sIy + sIz) > 0.5) {
      float dx = abs(sx_ - sIx);
      float dy = abs(sy_ - sIy);
      float dz = abs(-sx_ - sy_ - sIz);
      if (dx > dy && dx > dz) sIx = -sIy - sIz;
      else if (dz > dy)       sIz = -sIx - sIy;
    }
    vec2 sax     = vec2(sIx, sIz);              // small-hex axial
    vec2 soff    = vec2(sax.x + floor(sax.y / 2.0), sax.y);  // small offset
    vec2 sCentre = vec2((2.0 * sax.x + sax.y) * sIR, 1.5 * sax.y * sOR);
    vec2 srel    = world - sCentre;
    // Small-hex SDF
    vec2 d   = abs(srel);
    float sbdist = sIR - max(d.x, d.x * 0.5 + d.y * 0.8660254);

    // Parity-aware sector masks (same logic as before, in small-hex space).
    float r3       = 1.7320508;
    float say      = abs(srel.y);
    float sax_     = abs(srel.x);
    bool sOddRow   = mod(soff.y, 2.0) > 0.5;
    bool sOnEast   = sOddRow ? (srel.x > 0.0)
                             : (srel.x >  say * r3);
    bool sOnWest   = sOddRow ? (srel.x < -say * r3)
                             : (srel.x < 0.0);
    bool sOnSouth  = srel.y < -sax_ / r3;
    bool sOnNorth  = srel.y >  sax_ / r3;

    // m32 = small-hex offset modulo chunk size (32).  m2560 = region size.
    // u_grid_offset shifts the entire chunk/region grid (small-hex units).
    vec2 sgrid = soff - u_grid_offset;
    vec2 m32   = mod(sgrid,   32.0);
    vec2 m2560 = mod(sgrid, 2560.0);

    if (u_show_chunks) {
      float lineW = max(aa * 1.6, sIR * 0.20);
      vec3  col   = vec3(0.97, 0.97, 1.00);
      float a     = 0.55;
      bool draw =
        ((m32.x <= 0.5  && sOnWest)  || (m32.x >= 30.5 && sOnEast) ||
         (m32.y <= 0.5  && sOnSouth) || (m32.y >= 30.5 && sOnNorth));
      if (draw) {
        float t = 1.0 - smoothstep(0.0, lineW, sbdist);
        colour = mix(colour, col, t * a);
      }
    }

    if (u_show_regions) {
      float lineW = max(aa * 3.5, sIR * 0.40);
      vec3  col   = vec3(0.0, 0.0, 0.0);
      float a     = 0.90;
      bool draw =
        ((m2560.x <= 0.5   && sOnWest)  || (m2560.x >= 2558.5 && sOnEast) ||
         (m2560.y <= 0.5   && sOnSouth) || (m2560.y >= 2558.5 && sOnNorth));
      if (draw) {
        float t = 1.0 - smoothstep(0.0, lineW, sbdist);
        colour = mix(colour, col, t * a);
      }
    }
  }


  outColor = vec4(colour, 1.0);
}

`;

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(
      `${type === gl.VERTEX_SHADER ? "Vertex" : "Fragment"} shader compile error:\n${log}`
    );
  }
  return s;
}

function linkProgram(gl, vs, fs, attribLocations = {}) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  // Force attribute locations BEFORE link, so that we can still
  // vertexAttribPointer() them even if the shader compiler optimised the
  // attribute out (e.g. in a debug branch). Otherwise getAttribLocation()
  // returns -1 and vertexAttribPointer(-1, …) errors.
  for (const [name, idx] of Object.entries(attribLocations)) {
    gl.bindAttribLocation(p, idx, name);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`Program link error:\n${log}`);
  }
  return p;
}

export class HexLayer {
  constructor({ meta, biomes, dataTextureUrl, elevTextureUrl }) {
    this.id = "hex-layer";
    this.type = "custom";
    this.renderingMode = "2d";

    this.meta = meta;
    this.biomes = biomes;
    this.dataTextureUrl = dataTextureUrl;
    this.elevTextureUrl = elevTextureUrl
      || (dataTextureUrl ? dataTextureUrl.replace(/world_data\.png$/, "world_elev.png") : null);

    this.options = {
      showChunks: false,
      showRegions: true,
      // Small-hex offset for the chunk/region grid. The grid is aligned to
      // multiples of 32 small hexes from the world origin (0, 0).
      // Adjust if your data offsets it differently.
      gridOffset: [0, 0],
      // Fractional offset of the LARGE-hex visual grid relative to the small
      // (real game) grid, expressed in small-hex offset units. Allows aligning
      // the data-texture lookup to the game's actual hex positions.
      largeHexOffset: [0, 0],
      // Elevation-based color modulation, matching the game shader. Disable
      // to see the raw .gwm colors unmodified.
      useElevation: true,
      // The three game-shader constants (defaults pulled from the decompiled
      // Map/TerrainGlobalMap material).
      elevMult:       0.045,
      underwaterPow:  1.25,
      colorSoftener:  0.015,
      // Coast outline: thin dark strip drawn on the land side of every
      // hex that has at least one Ocean neighbour.
      showCoast:      true,
      // OutlineThickness=10 game units, OR scales 1unit = 80 game units →
      // 10/80 = 0.125 in our world. The game's tonemap may also nudge this;
      // a slightly tighter value reads as a crisp line.
      coastThickness: 0.10,
      // luminance(OutlineColor=(0.106, 0.125, 0.141)) ≈ 0.121
      coastColor:     [0.121, 0.121, 0.121],
      debug: 0,
    };

    // Filled in onAdd
    this.gl = null;
    this.map = null;
    this.program = null;
    this.vbo = null;
    this.dataTex = null;
    this.elevTex = null;
    this.uniforms = {};
    this.attribs = {};
  }

  setOption(key, value) {
    this.options[key] = value;
    if (this.map) this.map.triggerRepaint();
  }

  // -- MapLibre custom-layer lifecycle ----------------------------------
  onAdd(map, gl) {
    try {
      this._onAddImpl(map, gl);
      console.log("[hex_layer] onAdd OK — program:", this.program,
                  "vbo:", this.vbo, "vao:", this.vao,
                  "dataTex:", this.dataTex, "elevTex:", this.elevTex);
    } catch (err) {
      console.error("[hex_layer] onAdd FAILED:", err);
      // Re-throw so MapLibre also sees it.
      throw err;
    }
  }

  _onAddImpl(map, gl) {
    this.map = map;
    this.gl = gl;

    // Diagnostic: which WebGL?
    const isGL2 = typeof WebGL2RenderingContext !== "undefined"
                  && gl instanceof WebGL2RenderingContext;
    console.log("[hex_layer] context is", isGL2 ? "WebGL2" : "WebGL1");

    // Compile + link, with explicit attrib locations so they survive shader
    // dead-code elimination.
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = linkProgram(gl, vs, fs, { a_pos: 0, a_world: 1 });

    // Cache uniform/attrib locations
    const u = (n) => gl.getUniformLocation(this.program, n);
    this.uniforms = {
      matrix:           u("u_matrix"),
      data:             u("u_data"),
      elev:             u("u_elev"),
      dataSize:         u("u_data_size"),
      IR:               u("u_IR"),
      OR:               u("u_OR"),
      showChunks:       u("u_show_chunks"),
      showRegions:      u("u_show_regions"),
      gridOffset:       u("u_grid_offset"),
      largeHexOffset:   u("u_large_hex_offset_world"),
      useElev:          u("u_use_elev"),
      elevMult:         u("u_elev_mult"),
      underwaterPow:    u("u_underwater_pow"),
      soften:           u("u_soften"),
      showCoast:        u("u_show_coast"),
      coastThickness:   u("u_coast_thickness"),
      coastColor:       u("u_coast_color"),
      debug:            u("u_debug"),
    };
    this.attribs = { pos: 0, world: 1 };  // forced via bindAttribLocation

    // Build the quad covering the world.
    const [lng0, lng1] = this.meta.map_lng_range;
    const [lat0, lat1] = this.meta.map_lat_range;
    const sw = maplibregl.MercatorCoordinate.fromLngLat({ lng: lng0, lat: lat0 });
    const se = maplibregl.MercatorCoordinate.fromLngLat({ lng: lng1, lat: lat0 });
    const nw = maplibregl.MercatorCoordinate.fromLngLat({ lng: lng0, lat: lat1 });
    const ne = maplibregl.MercatorCoordinate.fromLngLat({ lng: lng1, lat: lat1 });

    // World-pixel-space coords matching each corner.
    const W = this.meta.world_pixel_w;
    const H = this.meta.world_pixel_h;

    // For float32 precision at high zoom we shift the vertex positions to be
    // relative to the quad's centre. The translation is baked into the matrix
    // on every render. Magnitudes in the shader stay near zero → no jitter.
    const cx = (sw.x + ne.x) / 2;
    const cy = (sw.y + ne.y) / 2;
    this._centerMerc = [cx, cy];
    this._scratchMat = new Float32Array(16);

    // Triangle strip: SW, SE, NW, NE
    // a_pos.x, a_pos.y are relative to the centre.
    const verts = new Float32Array([
      sw.x - cx, sw.y - cy,  0, 0,
      se.x - cx, se.y - cy,  W, 0,
      nw.x - cx, nw.y - cy,  0, H,
      ne.x - cx, ne.y - cy,  W, H,
    ]);

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    // Set up VAO capturing all attribute state. MapLibre uses VAOs internally
    // and may switch them between frames; with our own VAO we restore the
    // full attrib pointer setup with a single bindVertexArray call.
    if (isGL2) {
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const stride = 4 * 4;
      gl.enableVertexAttribArray(this.attribs.pos);
      gl.vertexAttribPointer(this.attribs.pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.attribs.world);
      gl.vertexAttribPointer(this.attribs.world, 2, gl.FLOAT, false, stride, 2 * 4);
      gl.bindVertexArray(null);
    } else {
      this.vao = null;
    }

    // Helper to create a NEAREST-filtered RGBA texture seeded with a placeholder
    // and lazily replaced by the image at `url`.
    const loadTex = (url, placeholderPixel) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(placeholderPixel));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,  gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,  gl.CLAMP_TO_EDGE);
      if (url) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          // Critical: leave alpha as authored. Without these the browser/GPU
          // may premultiply RGB by A on upload, which would crush our raw
          // color bytes when A is small.
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          if (url === this.dataTextureUrl) {
            this.dataWidth = img.naturalWidth;
            this.dataHeight = img.naturalHeight;
          }
          this.map.triggerRepaint();
        };
        img.onerror = (e) => {
          console.error("Failed to load texture:", url, e);
        };
        img.src = url;
      }
      return tex;
    };

    this.dataWidth = this.meta.gwm_width;
    this.dataHeight = this.meta.gwm_height;
    // Color texture: 1×1 placeholder is fully empty (A=0) so the layer stays
    // transparent until the real image arrives.
    this.dataTex = loadTex(this.dataTextureUrl, [0, 0, 0, 0]);
    // Elevation texture: 0.5 (sea level) keeps modulation neutral.
    this.elevTex = loadTex(this.elevTextureUrl, [128, 0, 0, 255]);
  }

  onRemove() {
    const gl = this.gl;
    if (this.vbo)     gl.deleteBuffer(this.vbo);
    if (this.dataTex) gl.deleteTexture(this.dataTex);
    if (this.elevTex) gl.deleteTexture(this.elevTex);
    if (this.vao)     gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
  }

  // -- Main render --------------------------------------------------------
  render(gl, matrix) {
    // Render every frame, even before the data texture has loaded, so debug
    // modes are visible immediately.

    // MapLibre may leave any GL state enabled from prior layers — reset.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    // Empty hexes write vec4(0); enable alpha blending so the dark background
    // shows through instead of the texture's placeholder/black.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
                         gl.ONE,       gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);

    // Bind our VAO (WebGL2) or re-set attribs manually (WebGL1).
    if (this.vao) {
      gl.bindVertexArray(this.vao);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const stride = 4 * 4;
      gl.enableVertexAttribArray(this.attribs.pos);
      gl.vertexAttribPointer(this.attribs.pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.attribs.world);
      gl.vertexAttribPointer(this.attribs.world, 2, gl.FLOAT, false, stride, 2 * 4);
    }

    // Uniforms. Guarded against null locations (uniform may be optimised out).
    const U = this.uniforms;
    const set1i   = (loc, v)    => { if (loc !== null) gl.uniform1i(loc, v); };
    const set1f   = (loc, v)    => { if (loc !== null) gl.uniform1f(loc, v); };
    const set2f   = (loc, a, b) => { if (loc !== null) gl.uniform2f(loc, a, b); };
    const setMat4 = (loc, m)    => { if (loc !== null) gl.uniformMatrix4fv(loc, false, m); };

    // Translate the matrix by the quad centre so the shader can use small,
    // precision-friendly position values for the quad corners.
    //   M' = M * T(c)
    //   M'.col3 = M.col0 * c.x + M.col1 * c.y + M.col3
    const c = this._centerMerc;
    const m = this._scratchMat;
    for (let i = 0; i < 16; i++) m[i] = matrix[i];
    m[12] = matrix[0] * c[0] + matrix[4] * c[1] + matrix[12];
    m[13] = matrix[1] * c[0] + matrix[5] * c[1] + matrix[13];
    m[14] = matrix[2] * c[0] + matrix[6] * c[1] + matrix[14];
    m[15] = matrix[3] * c[0] + matrix[7] * c[1] + matrix[15];
    setMat4(U.matrix, m);

    // Data texture → unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    set1i(U.data, 0);
    set2f(U.dataSize, this.dataWidth, this.dataHeight);

    // Elevation texture → unit 1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.elevTex);
    set1i(U.elev, 1);

    set1f(U.IR, this.meta.inner_radius);
    set1f(U.OR, this.meta.outer_radius);

    set1i(U.useElev,       this.options.useElevation ? 1 : 0);
    set1f(U.elevMult,      this.options.elevMult);
    set1f(U.underwaterPow, this.options.underwaterPow);
    set1f(U.soften,        this.options.colorSoftener);

    set1i(U.showCoast,      this.options.showCoast ? 1 : 0);
    set1f(U.coastThickness, this.options.coastThickness);
    if (U.coastColor !== null) {
      const cc = this.options.coastColor;
      gl.uniform3f(U.coastColor, cc[0], cc[1], cc[2]);
    }

    set1i(U.showChunks,   this.options.showChunks   ? 1 : 0);
    set1i(U.showRegions,  this.options.showRegions  ? 1 : 0);
    set1i(U.debug,        this.options.debug | 0);

    const go = this.options.gridOffset || [0, 0];
    set2f(U.gridOffset, go[0], go[1]);

    // Large-hex visual offset: caller specifies it in SMALL-hex offset units
    // (1 chunk = 32 small hexes). Convert to world pixel units here.
    //   small hex inscribed/outer radii are 1/3.2 of the large ones.
    //   pixel_x per small-col = 2 * sIR;  pixel_y per small-row = 1.5 * sOR.
    const lho = this.options.largeHexOffset || [0, 0];
    const sIR = this.meta.inner_radius / 3.2;
    const sOR = this.meta.outer_radius / 3.2;
    set2f(U.largeHexOffset, lho[0] * 2 * sIR, lho[1] * 1.5 * sOR);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Unbind VAO so we don't accidentally leak state into MapLibre's layers.
    if (this.vao) gl.bindVertexArray(null);
  }

}
