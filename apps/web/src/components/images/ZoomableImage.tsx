import { Minus, Plus } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import {
  IMAGE_ZOOM_STEP,
  clampImageTransform,
  fitImageTransform,
  imageFitScale,
  imagePanBounds,
  isImageScaleAtFit,
  isImageScaleAtMaximum,
  panImageTransform,
  steppedImageScale,
  zoomImageTransform,
  type ImagePoint,
  type ImageSize,
  type ImageViewportTransform,
} from "./imageViewport";

const INITIAL_TRANSFORM: ImageViewportTransform = {
  mode: "fit",
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};
const KEYBOARD_PAN_STEP = 40;

interface DragState {
  readonly pointerId: number;
  x: number;
  y: number;
}

interface ZoomableImageProps {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
  readonly imageClassName?: string;
  readonly onError?: () => void;
}

function sameSize(left: ImageSize | null, right: ImageSize): boolean {
  return left?.width === right.width && left.height === right.height;
}

export function ZoomableImage({
  src,
  alt,
  className,
  imageClassName,
  onError,
}: ZoomableImageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [viewportSize, setViewportSize] = useState<ImageSize | null>(null);
  const [transform, setTransform] = useState<ImageViewportTransform>(INITIAL_TRANSFORM);
  const [dragging, setDragging] = useState(false);

  const geometry = useMemo(
    () => (imageSize && viewportSize ? { image: imageSize, viewport: viewportSize } : null),
    [imageSize, viewportSize],
  );
  const fitScale = geometry ? imageFitScale(geometry.image, geometry.viewport) : 1;
  const panBounds = geometry
    ? imagePanBounds(geometry.image, geometry.viewport, transform.scale)
    : { x: 0, y: 0 };
  const canPan = panBounds.x > 0 || panBounds.y > 0;

  const measureImage = useCallback(() => {
    const image = imageRef.current;
    if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    const next = { width: image.naturalWidth, height: image.naturalHeight };
    setImageSize((current) => (sameSize(current, next) ? current : next));
  }, []);

  useEffect(() => {
    setImageSize(null);
    setTransform(INITIAL_TRANSFORM);
    dragRef.current = null;
    setDragging(false);

    const image = imageRef.current;
    if (image?.complete) measureImage();
  }, [measureImage, src]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const next = { width: rect.width, height: rect.height };
      setViewportSize((current) => (sameSize(current, next) ? current : next));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!geometry) return;
    setTransform((current) =>
      current.mode === "fit"
        ? fitImageTransform(geometry.image, geometry.viewport)
        : clampImageTransform(current, geometry.image, geometry.viewport),
    );
  }, [
    geometry?.image.height,
    geometry?.image.width,
    geometry?.viewport.height,
    geometry?.viewport.width,
  ]);

  const zoomTo = useCallback(
    (scale: number, anchor?: ImagePoint) => {
      if (!geometry) return;
      const target = anchor ?? {
        x: geometry.viewport.width / 2,
        y: geometry.viewport.height / 2,
      };
      setTransform((current) =>
        zoomImageTransform(current, scale, target, geometry.image, geometry.viewport),
      );
    },
    [geometry],
  );

  const stepZoom = useCallback(
    (direction: "in" | "out", anchor?: ImagePoint) => {
      if (!geometry) return;
      setTransform((current) =>
        zoomImageTransform(
          current,
          steppedImageScale(current.scale, direction, fitScale),
          anchor ?? {
            x: geometry.viewport.width / 2,
            y: geometry.viewport.height / 2,
          },
          geometry.image,
          geometry.viewport,
        ),
      );
    },
    [fitScale, geometry],
  );

  const fitImage = useCallback(() => {
    if (!geometry) return;
    setTransform(fitImageTransform(geometry.image, geometry.viewport));
  }, [geometry]);

  const showActualSize = useCallback(
    (anchor?: ImagePoint) => {
      zoomTo(1, anchor);
    },
    [zoomTo],
  );

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!geometry || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();

      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const scale = transform.scale * Math.pow(IMAGE_ZOOM_STEP, -delta / 100);
      zoomTo(scale, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    },
    [geometry, transform.scale, zoomTo],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      rootRef.current?.focus({ preventScroll: true });
      if (!canPan || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      setDragging(true);
    },
    [canPan],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!geometry || !drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const delta = { x: event.clientX - drag.x, y: event.clientY - drag.y };
      drag.x = event.clientX;
      drag.y = event.clientY;
      setTransform((current) =>
        panImageTransform(current, delta, geometry.image, geometry.viewport),
      );
    },
    [geometry],
  );

  const finishPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleDoubleClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!geometry) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (isImageScaleAtFit(transform.scale, fitScale)) {
        showActualSize(anchor);
      } else {
        fitImage();
      }
    },
    [fitImage, fitScale, geometry, showActualSize, transform.scale],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.shiftKey && geometry && canPan) {
        const delta =
          event.key === "ArrowLeft"
            ? { x: -KEYBOARD_PAN_STEP, y: 0 }
            : event.key === "ArrowRight"
              ? { x: KEYBOARD_PAN_STEP, y: 0 }
              : event.key === "ArrowUp"
                ? { x: 0, y: -KEYBOARD_PAN_STEP }
                : event.key === "ArrowDown"
                  ? { x: 0, y: KEYBOARD_PAN_STEP }
                  : null;
        if (delta) {
          event.preventDefault();
          event.stopPropagation();
          setTransform((current) =>
            panImageTransform(current, delta, geometry.image, geometry.viewport),
          );
          return;
        }
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        stepZoom("in");
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        stepZoom("out");
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        showActualSize();
        return;
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        fitImage();
      }
    },
    [canPan, fitImage, geometry, showActualSize, stepZoom],
  );

  const imageStyle = useMemo<CSSProperties | undefined>(() => {
    if (!imageSize) return undefined;
    return {
      width: imageSize.width,
      height: imageSize.height,
      transform: `scale(${transform.scale})`,
      transformOrigin: "center",
    };
  }, [imageSize, transform.scale]);

  const imagePositionStyle = useMemo<CSSProperties>(
    () => ({
      transform: `translate(-50%, -50%) translate(${transform.offsetX}px, ${transform.offsetY}px)`,
    }),
    [transform.offsetX, transform.offsetY],
  );

  const zoomPercent = `${Math.round(transform.scale * 100)}%`;
  const atFit = isImageScaleAtFit(transform.scale, fitScale);
  const atActualSize = Math.abs(transform.scale - 1) < 0.001;

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative min-h-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
      role="region"
      aria-label={`${alt} image viewer`}
      data-keybinding-capture=""
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={viewportRef}
        className={cn(
          "absolute inset-0 overflow-hidden touch-none",
          dragging ? "cursor-grabbing" : canPan ? "cursor-grab" : "cursor-zoom-in",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
        onLostPointerCapture={finishPointerDrag}
        onDoubleClick={handleDoubleClick}
      >
        <div className="pointer-events-none absolute left-1/2 top-1/2" style={imagePositionStyle}>
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            className={cn(
              "block max-w-none select-none",
              imageSize ? "opacity-100" : "opacity-0",
              imageClassName,
            )}
            style={imageStyle}
            draggable={false}
            onLoad={measureImage}
            onError={onError}
          />
        </div>
      </div>

      <div
        className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border/70 bg-popover/92 p-1 shadow-md backdrop-blur"
        role="toolbar"
        aria-label="Image zoom controls"
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out image"
          onClick={() => stepZoom("out")}
          disabled={!geometry || atFit}
        >
          <Minus />
        </Button>
        <output
          className="min-w-12 text-center text-xs tabular-nums text-muted-foreground"
          aria-label={`Image zoom ${zoomPercent}`}
          aria-live="polite"
        >
          {zoomPercent}
        </output>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in image"
          onClick={() => stepZoom("in")}
          disabled={!geometry || isImageScaleAtMaximum(transform.scale)}
        >
          <Plus />
        </Button>
        <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
        <Button
          variant={atFit ? "secondary" : "ghost"}
          size="xs"
          aria-label="Fit image to view"
          aria-pressed={atFit}
          onClick={fitImage}
          disabled={!geometry}
        >
          Fit
        </Button>
        <Button
          variant={atActualSize ? "secondary" : "ghost"}
          size="xs"
          aria-label="Show image at actual size"
          aria-pressed={atActualSize}
          onClick={() => showActualSize()}
          disabled={!geometry || (atActualSize && fitScale === 1)}
        >
          1:1
        </Button>
      </div>
    </div>
  );
}
