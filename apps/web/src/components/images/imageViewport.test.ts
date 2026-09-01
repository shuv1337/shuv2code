import { describe, expect, it } from "vite-plus/test";

import {
  MAX_IMAGE_SCALE,
  clampImageTransform,
  fitImageTransform,
  imageFitScale,
  panImageTransform,
  steppedImageScale,
  zoomImageTransform,
} from "./imageViewport";

const image = { width: 2000, height: 1000 };
const viewport = { width: 1000, height: 800 };

describe("image viewport geometry", () => {
  it("fits large images without upscaling small images", () => {
    expect(imageFitScale(image, viewport)).toBe(0.5);
    expect(imageFitScale({ width: 400, height: 300 }, viewport)).toBe(1);
    expect(fitImageTransform(image, viewport)).toEqual({
      mode: "fit",
      scale: 0.5,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it("keeps the image point under the cursor stable while zooming", () => {
    const next = zoomImageTransform(
      fitImageTransform(image, viewport),
      1,
      { x: 750, y: 300 },
      image,
      viewport,
    );

    expect(next).toEqual({
      mode: "manual",
      scale: 1,
      offsetX: -250,
      offsetY: 100,
    });
  });

  it("clamps panning so the image cannot be lost outside the viewport", () => {
    const zoomed = zoomImageTransform(
      fitImageTransform(image, viewport),
      1,
      { x: 500, y: 400 },
      image,
      viewport,
    );

    expect(panImageTransform(zoomed, { x: 5000, y: -5000 }, image, viewport)).toEqual({
      mode: "manual",
      scale: 1,
      offsetX: 500,
      offsetY: -100,
    });
  });

  it("reclamps a manual transform after the viewport changes size", () => {
    expect(
      clampImageTransform({ mode: "manual", scale: 1, offsetX: 500, offsetY: -100 }, image, {
        width: 1800,
        height: 900,
      }),
    ).toEqual({
      mode: "manual",
      scale: 1,
      offsetX: 100,
      offsetY: -50,
    });
  });

  it("snaps across actual size and respects fit and maximum bounds", () => {
    expect(steppedImageScale(0.9, "in", 0.5)).toBe(1);
    expect(steppedImageScale(1.1, "out", 0.5)).toBe(1);
    expect(steppedImageScale(0.5, "out", 0.5)).toBe(0.5);
    expect(steppedImageScale(MAX_IMAGE_SCALE, "in", 0.5)).toBe(MAX_IMAGE_SCALE);
  });
});
