const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const MAX_TOOL_RESULT_IMAGES = 8;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_BASE64_CHARACTERS = Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4;

export interface ToolResultImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly previewUrl?: string;
  readonly workspacePath?: string;
  readonly error?: string;
}

interface ExtractionBudget {
  count: number;
  inlineBytes: number;
  omittedCount: number;
}

type InlineImageResult =
  | { readonly ok: true; readonly mimeType: string; readonly previewUrl: string }
  | { readonly ok: false; readonly reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function safeInlineImageMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return INLINE_IMAGE_MIME_TYPES.has(normalized) ? normalized : null;
}

function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64Prefix(value: string): Uint8Array | null {
  try {
    const prefix = value.slice(0, Math.min(value.length, 64));
    const decoded = atob(prefix);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function matchesImageSignature(mimeType: string, base64: string): boolean {
  const bytes = decodeBase64Prefix(base64);
  if (!bytes) return false;
  switch (mimeType) {
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/jpeg":
    case "image/jpg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
    case "image/bmp":
      return ascii(bytes, 0, 2) === "BM";
    case "image/avif":
      return ascii(bytes, 4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 4));
    default:
      return false;
  }
}

function reserveImage(budget: ExtractionBudget): boolean {
  if (budget.count >= MAX_TOOL_RESULT_IMAGES) {
    budget.omittedCount += 1;
    return false;
  }
  budget.count += 1;
  return true;
}

function inlineImageDataUrl(
  mimeType: string,
  data: unknown,
  budget: ExtractionBudget,
): InlineImageResult {
  if (typeof data !== "string") return { ok: false, reason: "Image data is missing." };
  const base64 = data.trim();
  if (base64.length > MAX_INLINE_BASE64_CHARACTERS) {
    return { ok: false, reason: "Image omitted because it is larger than 8 MB." };
  }
  const byteLength = decodedBase64ByteLength(base64);
  if (byteLength === null || !matchesImageSignature(mimeType, base64)) {
    return { ok: false, reason: "Image data is invalid." };
  }
  if (byteLength > MAX_INLINE_IMAGE_BYTES) {
    return { ok: false, reason: "Image omitted because it is larger than 8 MB." };
  }
  if (budget.inlineBytes + byteLength > MAX_TOTAL_INLINE_IMAGE_BYTES) {
    return { ok: false, reason: "Image omitted because this tool result exceeds 20 MB." };
  }
  budget.inlineBytes += byteLength;
  return { ok: true, mimeType, previewUrl: `data:${mimeType};base64,${base64}` };
}

function parseInlineImageUrl(value: unknown, budget: ExtractionBudget): InlineImageResult | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("data:")) return null;
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0) return { ok: false, reason: "Image data URL is invalid." };
  const header = trimmed.slice(5, commaIndex).split(";");
  const mimeType = safeInlineImageMimeType(header[0]);
  const encoding = header.at(-1)?.trim().toLowerCase();
  if (!mimeType || encoding !== "base64") {
    return { ok: false, reason: "Image data URL uses an unsupported format." };
  }
  return inlineImageDataUrl(mimeType, trimmed.slice(commaIndex + 1), budget);
}

function inferBase64ImageMimeType(value: string): string | null {
  for (const mimeType of INLINE_IMAGE_MIME_TYPES) {
    if (matchesImageSignature(mimeType, value)) return mimeType;
  }
  return null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1)?.trim() || "Image";
}

function imageLabel(label: string, index: number, total: number): string {
  const normalized = label.replace(/[_.-]+/g, " ").trim() || "Tool result";
  const withImage = normalized.toLowerCase().endsWith(" image")
    ? normalized
    : `${normalized} image`;
  return total > 1 ? `${withImage} ${index + 1}` : withImage;
}

function inlineResultImage(
  id: string,
  name: string,
  mimeType: string,
  result: InlineImageResult,
): ToolResultImage {
  return result.ok
    ? { id, name, mimeType: result.mimeType, previewUrl: result.previewUrl }
    : { id, name, mimeType, error: result.reason };
}

function extractMcpImages(
  item: Record<string, unknown>,
  label: string,
  idPrefix: string,
  budget: ExtractionBudget,
): ToolResultImage[] {
  const result = asRecord(item.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const imageBlocks = content.flatMap((value) => {
    const block = asRecord(value);
    const mimeType = block?.type === "image" ? safeInlineImageMimeType(block.mimeType) : null;
    return block && mimeType ? [{ block, mimeType }] : [];
  });
  const images = imageBlocks.flatMap(({ block, mimeType }, index) => {
    if (!reserveImage(budget)) return [];
    const name =
      typeof block.name === "string" && block.name.trim().length > 0
        ? block.name.trim()
        : imageLabel(label, index, imageBlocks.length);
    return [
      inlineResultImage(
        `${idPrefix}:content:${index}`,
        name,
        mimeType,
        inlineImageDataUrl(mimeType, block.data, budget),
      ),
    ];
  });

  const generated = asRecord(result?.generatedImage ?? result?.generated_image);
  const generatedValue = generated?.image_url ?? generated?.imageUrl;
  if (generatedValue !== undefined && reserveImage(budget)) {
    const generatedUrl = parseInlineImageUrl(generatedValue, budget);
    const name =
      typeof generated?.output_hint === "string" && generated.output_hint.trim().length > 0
        ? generated.output_hint.trim()
        : imageLabel(label, images.length, images.length + 1);
    images.push(
      generatedUrl
        ? inlineResultImage(`${idPrefix}:generated`, name, "image/*", generatedUrl)
        : {
            id: `${idPrefix}:generated`,
            name,
            mimeType: "image/*",
            error: "Remote tool images are not loaded automatically.",
          },
    );
  }
  return images;
}

function extractImageGeneration(
  item: Record<string, unknown>,
  label: string,
  idPrefix: string,
  budget: ExtractionBudget,
): ToolResultImage[] {
  if (
    item.type !== "imageGeneration" ||
    item.status !== "completed" ||
    typeof item.result !== "string" ||
    !reserveImage(budget)
  ) {
    return [];
  }
  const savedPath = typeof item.savedPath === "string" ? item.savedPath.trim() : "";
  const name = savedPath ? fileName(savedPath) : imageLabel(label, 0, 1);
  const parsedUrl = parseInlineImageUrl(item.result, budget);
  if (parsedUrl) {
    return [inlineResultImage(`${idPrefix}:generated`, name, "image/*", parsedUrl)];
  }
  const base64 = item.result.trim();
  const mimeType = inferBase64ImageMimeType(base64);
  if (!mimeType) {
    return [
      {
        id: `${idPrefix}:generated`,
        name,
        mimeType: "image/*",
        error: "Generated image data is invalid.",
      },
    ];
  }
  return [
    inlineResultImage(
      `${idPrefix}:generated`,
      name,
      mimeType,
      inlineImageDataUrl(mimeType, base64, budget),
    ),
  ];
}

function extractImageView(
  item: Record<string, unknown>,
  idPrefix: string,
  budget: ExtractionBudget,
): ToolResultImage[] {
  if (item.type !== "imageView" || typeof item.path !== "string" || !reserveImage(budget)) {
    return [];
  }
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

export function extractToolResultImages(
  toolData: unknown,
  label: string,
  fallbackId: string,
): ToolResultImage[] {
  const item = asRecord(toolData);
  if (!item) return [];
  const idPrefix =
    typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : fallbackId;
  const budget: ExtractionBudget = { count: 0, inlineBytes: 0, omittedCount: 0 };
  const images = [
    ...extractMcpImages(item, label, idPrefix, budget),
    ...extractImageGeneration(item, label, idPrefix, budget),
    ...extractImageView(item, idPrefix, budget),
  ];
  const deduplicated = images.filter((image, index) => {
    if (!image.previewUrl && !image.workspacePath) return true;
    return (
      images.findIndex(
        (candidate) =>
          (image.previewUrl && candidate.previewUrl === image.previewUrl) ||
          (image.workspacePath && candidate.workspacePath === image.workspacePath),
      ) === index
    );
  });
  if (budget.omittedCount > 0) {
    deduplicated.push({
      id: `${idPrefix}:overflow`,
      name: "Additional images omitted",
      mimeType: "image/*",
      error: `${budget.omittedCount} additional image${budget.omittedCount === 1 ? " was" : "s were"} omitted.`,
    });
  }
  return deduplicated;
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
        if (parent.status !== "completed") return value;
        const isolatedBudget: ExtractionBudget = { count: 0, inlineBytes: 0, omittedCount: 0 };
        const parsed = parseInlineImageUrl(value, isolatedBudget);
        // Redact any data: payload, including rejected/unsafe formats (e.g. SVG).
        if (parsed) {
          return redactedImageValue(value, parsed.ok ? parsed.mimeType : "image");
        }
        const mimeType = inferBase64ImageMimeType(value);
        return mimeType ? redactedImageValue(value, mimeType) : value;
      }
      if ((key === "image_url" || key === "imageUrl") && value.startsWith("data:image/")) {
        const isolatedBudget: ExtractionBudget = { count: 0, inlineBytes: 0, omittedCount: 0 };
        const parsed = parseInlineImageUrl(value, isolatedBudget);
        return redactedImageValue(value, parsed?.ok ? parsed.mimeType : "image");
      }
      return value;
    },
    2,
  );
  return json ?? String(toolData);
}
