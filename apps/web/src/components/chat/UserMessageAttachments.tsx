import { FileTextIcon } from "lucide-react";

import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import type { UserMessageAttachment } from "./userMessageAttachments.logic";

/**
 * The image grid and file list a user message renders above its text.
 *
 * Extracted from `MessagesTimeline`'s `UserTimelineRow` so the captain
 * messenger's `MessageBubble` draws attachments with the *same* pieces rather
 * than a lookalike. Before this existed, an image-only message rendered as an
 * empty bubble — the text was all the messenger knew how to draw.
 *
 * The attachment shape is structural on purpose: both callers pass the same
 * provider attachments, and neither surface should have to import the other's
 * row types to draw a thumbnail.
 */
export function UserMessageImageGrid({
  images,
  onImageExpand,
}: {
  readonly images: ReadonlyArray<UserMessageAttachment>;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
      {images.map((image) => (
        <div
          key={image.id}
          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
        >
          {image.previewUrl ? (
            <button
              type="button"
              className="h-full w-full cursor-zoom-in"
              aria-label={`Preview ${image.name}`}
              onClick={() => {
                const preview = buildExpandedImagePreview(images, image.id);
                if (!preview) return;
                onImageExpand(preview);
              }}
            >
              <img
                src={image.previewUrl}
                alt={image.name}
                className="block h-auto max-h-[220px] w-full object-cover"
              />
            </button>
          ) : (
            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-secondary-label text-[11px]">
              {image.name}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function UserMessageFileList({
  files,
}: {
  readonly files: ReadonlyArray<UserMessageAttachment>;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mb-2 flex max-w-[420px] flex-col gap-1.5">
      {files.map((file) => {
        const content = (
          <>
            <FileTextIcon className="size-5 shrink-0 text-red-500/80" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{file.name}</span>
              <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                PDF
              </span>
            </span>
          </>
        );
        return file.previewUrl ? (
          <a
            key={file.id}
            href={file.previewUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-2.5 py-2 hover:bg-background"
            aria-label={`Open ${file.name}`}
          >
            {content}
          </a>
        ) : (
          <div
            key={file.id}
            className="flex items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-2.5 py-2"
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
