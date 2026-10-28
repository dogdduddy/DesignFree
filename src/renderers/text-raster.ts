/** Align raster origins to the sample grid and bound the temporary allocation. */
export function textRasterBounds(
  left: number,
  top: number,
  right: number,
  bottom: number,
  density: number,
) {
  const width = Math.max(1, right - left),
    height = Math.max(1, bottom - top);
  const scale = Math.min(
    Math.max(density, 0.01),
    4095 / width,
    4095 / height,
    Math.sqrt(3_990_000 / (width * height)),
  );
  left = Math.floor(left * scale) / scale;
  top = Math.floor(top * scale) / scale;
  const pixelWidth = Math.max(1, Math.ceil((right - left) * scale));
  const pixelHeight = Math.max(1, Math.ceil((bottom - top) * scale));
  return { left, top, scale, pixelWidth, pixelHeight };
}
