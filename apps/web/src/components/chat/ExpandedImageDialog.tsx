import { memo, useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { ZoomableImage } from "../images/ZoomableImage";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  const item = preview.images[index];
  if (!item) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
      data-slot="dialog-popup"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 flex h-[92vh] w-[92vw] min-w-0 flex-col">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2 z-30 bg-background/80 backdrop-blur"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        {failedSrc === item.src ? (
          <div
            className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-background px-6 text-center text-sm text-destructive shadow-2xl"
            role="alert"
          >
            Unable to load {item.name}.
          </div>
        ) : (
          <ZoomableImage
            key={`${index}:${item.src}`}
            src={item.src}
            alt={item.name}
            className="min-h-0 flex-1 rounded-lg border border-border/70 bg-background shadow-2xl"
            onError={() => setFailedSrc(item.src)}
          />
        )}
        <p className="mt-2 shrink-0 truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
});
