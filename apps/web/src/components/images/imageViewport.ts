export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface ImagePoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageViewportTransform {
  readonly mode: "fit" | "manual";
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export const MAX_IMAGE_SCALE = 8;
export const IMAGE_ZOOM_STEP = 1.25;

const SCALE_EPSILON = 0.001;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function imageFitScale(image: ImageSize, viewport: ImageSize): number {
  if (
    !finitePositive(image.width) ||
    !finitePositive(image.height) ||
    !finitePositive(viewport.width) ||
    !finitePositive(viewport.height)
  ) {
    return 1;
  }

  return Math.min(1, viewport.width / image.width, viewport.height / image.height);
}

export function fitImageTransform(image: ImageSize, viewport: ImageSize): ImageViewportTransform {
  return {
    mode: "fit",
    scale: imageFitScale(image, viewport),
    offsetX: 0,
    offsetY: 0,
  };
}

export function imagePanBounds(image: ImageSize, viewport: ImageSize, scale: number): ImagePoint {
  return {
    x: Math.max(0, (image.width * scale - viewport.width) / 2),
    y: Math.max(0, (image.height * scale - viewport.height) / 2),
  };
}

export function clampImageTransform(
  transform: ImageViewportTransform,
  image: ImageSize,
  viewport: ImageSize,
): ImageViewportTransform {
  const fitScale = imageFitScale(image, viewport);
  const scale = clamp(transform.scale, fitScale, MAX_IMAGE_SCALE);
  const bounds = imagePanBounds(image, viewport, scale);

  return {
    mode: Math.abs(scale - fitScale) < SCALE_EPSILON ? "fit" : transform.mode,
    scale,
    offsetX: clamp(transform.offsetX, -bounds.x, bounds.x),
    offsetY: clamp(transform.offsetY, -bounds.y, bounds.y),
  };
}

export function zoomImageTransform(
  transform: ImageViewportTransform,
  nextScale: number,
  anchor: ImagePoint,
  image: ImageSize,
  viewport: ImageSize,
): ImageViewportTransform {
  const fitScale = imageFitScale(image, viewport);
  const scale = clamp(nextScale, fitScale, MAX_IMAGE_SCALE);

  if (Math.abs(scale - fitScale) < SCALE_EPSILON) {
    return fitImageTransform(image, viewport);
  }

  const ratio = scale / transform.scale;
  const anchorFromCenterX = anchor.x - viewport.width / 2;
  const anchorFromCenterY = anchor.y - viewport.height / 2;

  return clampImageTransform(
    {
      mode: "manual",
      scale,
      offsetX: anchorFromCenterX - (anchorFromCenterX - transform.offsetX) * ratio,
      offsetY: anchorFromCenterY - (anchorFromCenterY - transform.offsetY) * ratio,
    },
    image,
    viewport,
  );
}

export function panImageTransform(
  transform: ImageViewportTransform,
  delta: ImagePoint,
  image: ImageSize,
  viewport: ImageSize,
): ImageViewportTransform {
  return clampImageTransform(
    {
      ...transform,
      mode: "manual",
      offsetX: transform.offsetX + delta.x,
      offsetY: transform.offsetY + delta.y,
    },
    image,
    viewport,
  );
}

function snapScaleAcrossActualSize(currentScale: number, candidateScale: number): number {
  if (currentScale < 1 && candidateScale > 1) return 1;
  if (currentScale > 1 && candidateScale < 1) return 1;
  return candidateScale;
}

export function steppedImageScale(
  currentScale: number,
  direction: "in" | "out",
  fitScale: number,
): number {
  const candidate =
    direction === "in" ? currentScale * IMAGE_ZOOM_STEP : currentScale / IMAGE_ZOOM_STEP;
  return clamp(snapScaleAcrossActualSize(currentScale, candidate), fitScale, MAX_IMAGE_SCALE);
}

export function isImageScaleAtFit(scale: number, fitScale: number): boolean {
  return Math.abs(scale - fitScale) < SCALE_EPSILON;
}

export function isImageScaleAtMaximum(scale: number): boolean {
  return Math.abs(scale - MAX_IMAGE_SCALE) < SCALE_EPSILON;
}
