const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export interface ToolResultImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly previewUrl?: string;
  readonly workspacePath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function safeInlineImageMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return INLINE_IMAGE_MIME_TYPES.has(normalized) ? normalized : null;
}

function inlineImageDataUrl(mimeType: string, data: unknown): string | null {
  if (typeof data !== "string" || data.length === 0) return null;
  return `data:${mimeType};base64,${data}`;
}

function parseInlineImageUrl(value: unknown): { mimeType: string; previewUrl: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("https://")) {
    return { mimeType: "image/*", previewUrl: trimmed };
  }
  if (!trimmed.toLowerCase().startsWith("data:")) return null;
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0) return null;
  const header = trimmed.slice(5, commaIndex).split(";");
  const mimeType = safeInlineImageMimeType(header[0]);
  const encoding = header.at(-1)?.trim().toLowerCase();
  if (!mimeType || encoding !== "base64" || commaIndex === trimmed.length - 1) return null;
  return { mimeType, previewUrl: trimmed };
}

function inferBase64ImageMimeType(value: string): string {
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("R0lGOD")) return "image/gif";
  if (value.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1)?.trim() || "Image";
}

function imageLabel(label: string, index: number, total: number): string {
  const normalized = label.replace(/[_.-]+/g, " ").trim() || "Tool result";
  return total > 1 ? `${normalized} image ${index + 1}` : `${normalized} image`;
}

function extractMcpImages(
  item: Record<string, unknown>,
  label: string,
  idPrefix: string,
): ToolResultImage[] {
  const result = asRecord(item.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const imageBlocks = content.flatMap((value) => {
    const block = asRecord(value);
    return block?.type === "image" ? [block] : [];
  });
  const images = imageBlocks.flatMap((block, index) => {
    const mimeType = safeInlineImageMimeType(block.mimeType);
    const previewUrl = mimeType ? inlineImageDataUrl(mimeType, block.data) : null;
    if (!mimeType || !previewUrl) return [];
    return [
      {
        id: `${idPrefix}:content:${index}`,
        name:
          typeof block.name === "string" && block.name.trim().length > 0
            ? block.name.trim()
            : imageLabel(label, index, imageBlocks.length),
        mimeType,
        previewUrl,
      },
    ];
  });

  const generated = asRecord(result?.generatedImage ?? result?.generated_image);
  const generatedUrl = parseInlineImageUrl(generated?.image_url ?? generated?.imageUrl);
  if (generatedUrl) {
    images.push({
      id: `${idPrefix}:generated`,
      name:
        typeof generated?.output_hint === "string" && generated.output_hint.trim().length > 0
          ? generated.output_hint.trim()
          : imageLabel(label, images.length, images.length + 1),
      ...generatedUrl,
    });
  }
  return images;
}

function extractImageGeneration(
  item: Record<string, unknown>,
  label: string,
  idPrefix: string,
): ToolResultImage[] {
  if (item.type !== "imageGeneration" || typeof item.result !== "string") return [];
  const parsedUrl = parseInlineImageUrl(item.result);
  const savedPath = typeof item.savedPath === "string" ? item.savedPath.trim() : "";
  const name = savedPath ? fileName(savedPath) : imageLabel(label, 0, 1);
  if (parsedUrl) {
    return [{ id: `${idPrefix}:generated`, name, ...parsedUrl }];
  }
  const result = item.result.trim();
  if (result.length === 0) return [];
  const mimeType = inferBase64ImageMimeType(result);
  const previewUrl = inlineImageDataUrl(mimeType, result);
  if (!previewUrl) return [];
  return [
    {
      id: `${idPrefix}:generated`,
      name,
      mimeType,
      previewUrl,
    },
  ];
}

function extractImageView(item: Record<string, unknown>, idPrefix: string): ToolResultImage[] {
  if (item.type !== "imageView" || typeof item.path !== "string") return [];
  const workspacePath = item.path.trim();
  if (workspacePath.length === 0) return [];
  return [
    {
      id: `${idPrefix}:view`,
      name: fileName(workspacePath),
      mimeType: "image/*",
      workspacePath,
    },
  ];
}

export function extractToolResultImages(toolData: unknown, label: string): ToolResultImage[] {
  const item = asRecord(toolData);
  if (!item) return [];
  const idPrefix =
    typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : "tool-result";
  return [
    ...extractMcpImages(item, label, idPrefix),
    ...extractImageGeneration(item, label, idPrefix),
    ...extractImageView(item, idPrefix),
  ];
}

function redactedImageValue(value: string, mimeType: string): string {
  return `[${mimeType} image data omitted; ${value.length} characters]`;
}

export function stringifyToolDataForDisplay(toolData: unknown): string {
  const json = JSON.stringify(
    toolData,
    function (key, value: unknown) {
      const parent = asRecord(this);
      if (typeof value !== "string" || !parent) return value;
      if (key === "data" && parent.type === "image") {
        return redactedImageValue(value, safeInlineImageMimeType(parent.mimeType) ?? "image");
      }
      if (key === "result" && parent.type === "imageGeneration") {
        const parsed = parseInlineImageUrl(value);
        if (parsed?.previewUrl.startsWith("data:")) {
          return redactedImageValue(value, parsed.mimeType);
        }
        if (!parsed) {
          return redactedImageValue(value, inferBase64ImageMimeType(value));
        }
      }
      if ((key === "image_url" || key === "imageUrl") && value.startsWith("data:image/")) {
        const parsed = parseInlineImageUrl(value);
        return redactedImageValue(value, parsed?.mimeType ?? "image");
      }
      return value;
    },
    2,
  );
  return json ?? String(toolData);
}
