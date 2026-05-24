// Hex-grid math shared between the JS click handler and the WebGL fragment shader.
// Conventions match the Python data pipeline:
//   - offset coords (col, row), col = offset_x, row = offset_z
//   - axial coords  (ax,  az ), ax = col - floor(row/2), az = row
//   - pixel space pointy-top:
//       pixel_x = (2*ax + az) * INNER_RADIUS
//       pixel_y = 1.5 * az * OUTER_RADIUS
//   - .gwm row 0 = south, so larger row index = further north (up)

export const OUTER_RADIUS = 1.0;
export const INNER_RADIUS = OUTER_RADIUS * 0.8660254037844386;   // √3/2

/** World pixel-space → axial (ax, az) with proper rounding (cube method). */
export function pixelToAxial(px, py) {
  let x = px / (INNER_RADIUS * 2);
  let y = -x;
  const offset = py / (OUTER_RADIUS * 3);
  x -= offset;
  y -= offset;

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
  return { ax: ix, az: iz };
}

/** Axial → offset (col, row). */
export function axialToOffset(ax, az) {
  return { col: ax + Math.floor(az / 2), row: az };
}

/** Offset → axial. */
export function offsetToAxial(col, row) {
  return { ax: col - Math.floor(row / 2), az: row };
}

/** Offset (col, row) → world pixel-space (centre of hex). */
export function offsetToPixel(col, row) {
  const { ax, az } = offsetToAxial(col, row);
  return {
    x: (2 * ax + az) * INNER_RADIUS,
    y: 1.5 * az * OUTER_RADIUS,
  };
}

/** Convenience: pixel → offset (col, row). */
export function pixelToOffset(px, py) {
  const { ax, az } = pixelToAxial(px, py);
  return axialToOffset(ax, az);
}

/**
 * For a given grid of width W and height H (in offset coords),
 * compute the world-pixel-space extents the grid occupies.
 * Used to size the quad we draw.
 */
export function worldPixelBounds(W, H) {
  // The pointy-top hex grid in offset coords forms a parallelogram in pixel
  // space. The bounding rectangle spans:
  //   x: [0, (2*(W-1) + 1) * IR ]   (worst-case across all rows + half-hex shift)
  //   y: [-OR, 1.5*(H-1)*OR + OR]
  // We add OR/IR padding so hex extents are fully visible.
  return {
    minX: -INNER_RADIUS,
    maxX: (2 * (W - 1) + 1) * INNER_RADIUS + INNER_RADIUS,
    minY: -OUTER_RADIUS,
    maxY: 1.5 * (H - 1) * OUTER_RADIUS + OUTER_RADIUS,
  };
}
