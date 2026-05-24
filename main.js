// Entry point: bootstrap MapLibre, register the custom hex layer, wire HUD.

import { HexLayer } from "./hex_layer.js";
import {
  pixelToOffset, offsetToPixel,
  worldPixelBounds,
} from "./hex_math.js";

const COORDS_EL = document.getElementById("coords");

const params    = new URLSearchParams(location.search);
const debug     = params.has("debug");
const debugMode = parseInt(params.get("debug") || "0", 10) || 0;

async function loadJSON(url) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error(`Fetch ${url}: ${r.status}`);
  return await r.json();
}

async function main() {
  const meta = await loadJSON("data/world_meta.json");
  if (debug) console.log("meta", meta);

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

  // --- Cursor coords ---------------------------------------------------
  // Hover-only N, E readout (real in-game small-hex coords).
  map.on("mousemove", (e) => {
    const sOff = lngLatToSmallOffset(meta, e.lngLat);
    updateCoords(sOff);
  });
  map.on("mouseout", () => updateCoords(null));
}

// ─────────────────────────────────────────────────────────────────────────
// lng/lat → small-hex offset (the in-game N, E grid)
// ─────────────────────────────────────────────────────────────────────────
const SMALL_HEX_SCALE = 3.2;   // 1 large hex offset = 3.2 small hex offsets

function lngLatToSmallOffset(meta, ll) {
  const { lng, lat } = ll;
  const [lng0, lng1] = meta.map_lng_range;
  const [lat0, lat1] = meta.map_lat_range;
  if (lng < lng0 || lng > lng1 || lat < lat0 || lat > lat1) return null;
  const px = ((lng - lng0) / (lng1 - lng0)) * meta.world_pixel_w;
  const py = ((lat - lat0) / (lat1 - lat0)) * meta.world_pixel_h;

  // Inverse-Voronoi at small-hex radii (large_hex_radius / 3.2).
  const IR = meta.inner_radius / SMALL_HEX_SCALE;
  const OR = meta.outer_radius / SMALL_HEX_SCALE;
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

function updateCoords(sOff) {
  if (!sOff) {
    COORDS_EL.textContent = "— —";
    return;
  }
  // small-hex offset = real in-game coordinates (game UI shows N, E).
  COORDS_EL.textContent = `N ${sOff.row}, E ${sOff.col}`;
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
