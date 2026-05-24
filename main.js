// Entry point: bootstrap MapLibre, register the custom hex layer, wire HUD.

import { HexLayer } from "./hex_layer.js";
import {
  pixelToOffset, offsetToPixel,
  worldPixelBounds,
} from "./hex_math.js";

const COORDS_EL = document.getElementById("coords");
const LEGEND_EL = document.getElementById("legend");

const params    = new URLSearchParams(location.search);
const debug     = params.has("debug");
const debugMode = parseInt(params.get("debug") || "0", 10) || 0;

async function loadJSON(url) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error(`Fetch ${url}: ${r.status}`);
  return await r.json();
}

async function main() {
  // Load metadata + biome palette in parallel.
  const [meta, biomes] = await Promise.all([
    loadJSON("data/world_meta.json"),
    loadJSON("data/biomes.json"),
  ]);

  if (debug) console.log("meta", meta, "biomes", biomes);

  // --- Build the map ---------------------------------------------------
  // The world lives in tiny lng/lat range near (0, 0); MapLibre handles
  // pan/zoom/pinch automatically.
  const [lng0, lng1] = meta.map_lng_range;
  const [lat0, lat1] = meta.map_lat_range;
  const centerLng = (lng0 + lng1) / 2;
  const centerLat = (lat0 + lat1) / 2;

  // Zoom range — chosen so the entire world fits at the lowest zoom and
  // individual hexes are visible at the highest. Tweak after first run.
  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {},
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#070a13" },
        },
      ],
    },
    center: [centerLng, centerLat],
    zoom: 12,
    minZoom: 10,
    maxZoom: 22,
    pitchWithRotate: false,
    dragRotate: false,
    touchPitch: false,
    // Restrict the visible area roughly to our world. We pad slightly so the
    // user can pull the world away from the edge of the viewport.
    maxBounds: [
      [lng0 - (lng1 - lng0) * 0.5, lat0 - (lat1 - lat0) * 0.5],
      [lng1 + (lng1 - lng0) * 0.5, lat1 + (lat1 - lat0) * 0.5],
    ],
  });

  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
    "top-right"
  );

  // --- Register the hex layer ------------------------------------------
  const hexLayer = new HexLayer({
    meta,
    biomes,
    dataTextureUrl: "data/world_data.png",
  });
  hexLayer.options.debug = debugMode;
  // Empirical fine-tuning so our large-hex grid aligns with the game's
  // small-hex (real) grid. Set via console with `hexLayer.setOption(
  // 'largeHexOffset', [x, y])` to re-tune.
  hexLayer.setOption('largeHexOffset', [0.8, 1.3]);

  map.on("load", () => {
    try {
      map.addLayer(hexLayer);
    } catch (err) {
      console.error("addLayer threw:", err);
      throw err;
    }
    // After the map knows world extent, fit to it.
    map.fitBounds([[lng0, lat0], [lng1, lat1]], { padding: 30, animate: false });

    addMarkersSource(map);
  });

  // Expose to window for in-console tweaking:
  //   hexLayer.setOption('gridOffset', [-2, -2])
  //   hexLayer.setOption('showChunks', true)
  //   etc.
  window.hexLayer = hexLayer;
  window.map = map;

  // --- HUD wiring -------------------------------------------------------
  const buttons = [
    ["toggle-chunks",  "showChunks"],
    ["toggle-regions", "showRegions"],
  ];
  for (const [id, key] of buttons) {
    const btn = document.getElementById(id);
    btn.classList.toggle("active", !!hexLayer.options[key]);
    btn.addEventListener("click", () => {
      const next = !hexLayer.options[key];
      hexLayer.setOption(key, next);
      btn.classList.toggle("active", next);
    });
  }

  buildLegend(biomes);

  // --- Cursor coords ---------------------------------------------------
  // We only display the SMALL-hex coords (= the real in-game grid). No hover
  // highlight: the large hex is just a visual approximation and doesn't map
  // to any actual game cell.
  map.on("mousemove", (e) => {
    const sOff = lngLatToSmallOffset(meta, e.lngLat);
    updateCoords(sOff);
  });
  map.on("mouseout", () => updateCoords(null));

  // --- Click → popup ---------------------------------------------------
  map.on("click", (e) => {
    const sOff   = lngLatToSmallOffset(meta, e.lngLat);
    if (!sOff) return;
    // Biome / land-type / elevation comes from the data texture, which is
    // indexed by LARGE hex (shifted by largeHexOffset relative to the small
    // grid). Sampling at the shifted lng/lat picks the same hex the shader
    // renders for this position.
    const lOff = lngLatToLargeOffset(meta, e.lngLat,
                                     hexLayer.options.largeHexOffset);
    const data = lOff ? sampleHex(lOff) : null;
    showPopup(map, biomes, meta, e.lngLat, sOff, data);
  });

  // -- Preload data texture into a Canvas2D context so we can sample
  //    hex data without going through WebGL readback.
  preloadHexData(meta);
}

// ─────────────────────────────────────────────────────────────────────────
// Hex data preload (for click handler) — we read raw RGB from world_data.png
// and land_type from world_elev.png (since world_data.png's A is now 255).
// ─────────────────────────────────────────────────────────────────────────
let HEX_DATA = null;    // Uint8ClampedArray of world_data.png (RGBA, A=255)
let HEX_META = null;    // Uint8ClampedArray of world_elev.png (R=elev, G=lt)
let HEX_W = 0, HEX_H = 0;

function preloadHexData(meta) {
  const load = (url, setter) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      setter(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    };
    img.src = url;
  };
  load("data/world_data.png", (d, w, h) => { HEX_DATA = d; HEX_W = w; HEX_H = h; });
  load("data/world_elev.png", (d) => { HEX_META = d; });
}

function sampleHex({ col, row }) {
  if (!HEX_DATA) return null;
  // PNG rows are natively-compressed .gwm rows: large-az row N occupies
  // texel row round(N * √3/2). Match what the shader does.
  const SQRT3_2 = 0.8660254;
  const srcRow = Math.round(row * SQRT3_2);
  if (col < 0 || col >= HEX_W || srcRow < 0 || srcRow >= HEX_H) return null;
  const i = (srcRow * HEX_W + col) * 4;
  // world_data.png: R,G,B = raw color, A = 255 (opaque)
  // world_elev.png: R = elevation_u8, G = land_type
  return {
    rgb:       [HEX_DATA[i + 0], HEX_DATA[i + 1], HEX_DATA[i + 2]],
    elevation: HEX_META ? HEX_META[i + 0] / 255 : null,
    land_type: HEX_META ? HEX_META[i + 1] : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// lng/lat ↔ hex offset coords
// ─────────────────────────────────────────────────────────────────────────
const SMALL_HEX_SCALE = 3.2;   // 1 large hex offset = 3.2 small hex offsets

function lngLatToWorldPixel(meta, ll) {
  const { lng, lat } = ll;
  const [lng0, lng1] = meta.map_lng_range;
  const [lat0, lat1] = meta.map_lat_range;
  if (lng < lng0 || lng > lng1 || lat < lat0 || lat > lat1) return null;
  const W = meta.world_pixel_w;
  const H = meta.world_pixel_h;
  return {
    x: ((lng - lng0) / (lng1 - lng0)) * W,
    y: ((lat - lat0) / (lat1 - lat0)) * H,
  };
}

/** Small-hex offset coords (= the real in-game grid). */
function lngLatToSmallOffset(meta, ll) {
  const p = lngLatToWorldPixel(meta, ll);
  if (!p) return null;
  // Small hex pixel size = large / 3.2. Use the same inverse-Voronoi as the
  // large hex, just with shrunken radii.
  const sIR = meta.inner_radius / SMALL_HEX_SCALE;
  const sOR = meta.outer_radius / SMALL_HEX_SCALE;
  return pixelToOffsetScaled(p.x, p.y, sIR, sOR);
}

/** Large-hex offset (data-texture cell) for a click position. We subtract
 *  the configurable largeHexOffset (in small-hex offset units) so the
 *  sampled hex matches the one drawn by the shader. */
function lngLatToLargeOffset(meta, ll, largeHexOffsetSmall = [0, 0]) {
  const p = lngLatToWorldPixel(meta, ll);
  if (!p) return null;
  const sIR = meta.inner_radius / SMALL_HEX_SCALE;
  const sOR = meta.outer_radius / SMALL_HEX_SCALE;
  const shiftX = largeHexOffsetSmall[0] * 2 * sIR;
  const shiftY = largeHexOffsetSmall[1] * 1.5 * sOR;
  return pixelToOffsetScaled(p.x - shiftX, p.y - shiftY,
                             meta.inner_radius, meta.outer_radius);
}

/** Inverse Voronoi at arbitrary IR/OR. */
function pixelToOffsetScaled(px, py, IR, OR) {
  let x = px / (IR * 2);
  let y = -x;
  const offset = py / (OR * 3);
  x -= offset;  y -= offset;
  let ix = Math.round(x);
  let iy = Math.round(y);
  let iz = Math.round(-x - y);
  if (ix + iy + iz !== 0) {
    const dx = Math.abs(x - ix);
    const dy = Math.abs(y - iy);
    const dz = Math.abs(-x - y - iz);
    if (dx > dy && dx > dz) ix = -iy - iz;
    else if (dz > dy)       iz = -ix - iy;
  }
  return { col: ix + Math.floor(iz / 2), row: iz };
}

// ─────────────────────────────────────────────────────────────────────────
// HUD updates
// ─────────────────────────────────────────────────────────────────────────
const LAND_NAMES = ["Empty", "Land", "Ocean", "Contested", "Lake", "River", "Swamp"];

function updateCoords(sOff) {
  if (!sOff) {
    COORDS_EL.textContent = "— —";
    return;
  }
  // small-hex offset = real in-game coordinates (game UI shows N, E).
  COORDS_EL.textContent = `N ${sOff.row}, E ${sOff.col}`;
}

function showPopup(map, biomes, meta, lngLat, sOff, data) {
  const ltName  = data ? (LAND_NAMES[data.land_type] ?? `id ${data.land_type}`)
                       : "—";
  const swatch  = data ? `rgb(${data.rgb.join(",")})` : "transparent";
  const hex     = data ? "#" + data.rgb.map(v => v.toString(16).padStart(2, "0")).join("")
                       : "—";

  const html = `
    <div class="popup-row"><span class="popup-key">Color</span>     <span class="popup-val"><span style="display:inline-block;width:10px;height:10px;background:${swatch};border:1px solid rgba(255,255,255,.2);vertical-align:middle;margin-right:6px"></span>${hex}</span></div>
    <div class="popup-row"><span class="popup-key">LandType</span>  <span class="popup-val">${ltName}</span></div>
    <div class="popup-row"><span class="popup-key">N, E</span>      <span class="popup-val">${sOff.row}, ${sOff.col}</span></div>
  `;
  new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "240px" })
    .setLngLat(lngLat).setHTML(html).addTo(map);
}

function buildLegend(biomes) {
  // Show only "real" biomes (skip Empty placeholder + tiny clusters).
  const rows = biomes
    .filter((b) => b.id !== 0 && (b.count == null || b.count > 5000))
    .slice(0, 20);  // cap
  LEGEND_EL.innerHTML =
    `<h3>Biomes</h3>` +
    rows.map((b) => {
      const c = `rgb(${b.rgb.join(",")})`;
      return `<div class="legend-row">
                <span class="legend-swatch" style="background:${c}"></span>
                <span>${b.name}</span>
              </div>`;
    }).join("");
}

// ─────────────────────────────────────────────────────────────────────────
// Markers (settlements / POIs) — placeholder source for now
// ─────────────────────────────────────────────────────────────────────────
function addMarkersSource(map) {
  map.addSource("markers", {
    type: "geojson",
    data: "data/markers.geojson",
  });
  // Style placeholder — we'll add a real symbol layer when there's data.
  map.addLayer({
    id: "markers-circles",
    type: "circle",
    source: "markers",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 18, 12],
      "circle-color": "#f7c244",
      "circle-stroke-color": "#000",
      "circle-stroke-width": 1.5,
    },
  });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre style="position:absolute;top:60px;left:12px;background:#3a1a1a;color:#fbb;padding:10px;border-radius:6px;max-width:80vw;white-space:pre-wrap;font-size:12px">${err.stack || err}</pre>`,
  );
});
