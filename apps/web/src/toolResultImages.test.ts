import { describe, expect, it } from "vite-plus/test";

import { extractToolResultImages, stringifyToolDataForDisplay } from "./toolResultImages";

describe("tool result images", () => {
  it("extracts safe MCP image content blocks", () => {
    const images = extractToolResultImages(
      {
        id: "snapshot-call",
        type: "mcpToolCall",
        tool: "preview_snapshot",
        result: {
          content: [
            { type: "text", text: "snapshot metadata" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            { type: "image", data: "unsafe", mimeType: "image/svg+xml" },
          ],
        },
      },
      "shuv2code · preview_snapshot",
      "activity-snapshot",
    );

    expect(images).toEqual([
      {
        id: "snapshot-call:content:0",
        name: "shuv2code · preview snapshot image",
        mimeType: "image/png",
        previewUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    ]);
  });

  it("extracts Codex image generation results", () => {
    expect(
      extractToolResultImages(
        {
          id: "generated-call",
          type: "imageGeneration",
          result: "/9j/AAAA",
          savedPath: "/tmp/generated/cat.jpg",
          status: "completed",
        },
        "Generated image",
        "activity-generation",
      ),
    ).toEqual([
      {
        id: "generated-call:generated",
        name: "cat.jpg",
        mimeType: "image/jpeg",
        previewUrl: "data:image/jpeg;base64,/9j/AAAA",
      },
    ]);
  });

  it("keeps local image views as workspace resources", () => {
    expect(
      extractToolResultImages(
        {
          id: "view-call",
          type: "imageView",
          path: "/workspace/screenshots/result.png",
        },
        "Image view",
        "activity-view",
      ),
    ).toEqual([
      {
        id: "view-call:view",
        name: "result.png",
        mimeType: "image/*",
        workspacePath: "/workspace/screenshots/result.png",
      },
    ]);
  });

  it("does not turn failed or malformed image generation output into image URLs", () => {
    expect(
      extractToolResultImages(
        {
          type: "imageGeneration",
          result: "generation failed",
          status: "failed",
        },
        "Generated image",
        "failed-generation",
      ),
    ).toEqual([]);
    expect(
      extractToolResultImages(
        {
          type: "imageGeneration",
          result: "not base64 image data",
          status: "completed",
        },
        "Generated image",
        "malformed-generation",
      ),
    ).toEqual([
      {
        id: "malformed-generation:generated",
        name: "Generated image",
        mimeType: "image/*",
        error: "Generated image data is invalid.",
      },
    ]);
  });

  it("does not automatically fetch remote URLs from tool output", () => {
    expect(
      extractToolResultImages(
        {
          id: "remote-call",
          result: { generatedImage: { image_url: "https://tracker.invalid/image.png" } },
        },
        "Remote result",
        "activity-remote",
      ),
    ).toEqual([
      {
        id: "remote-call:generated",
        name: "Remote result image",
        mimeType: "image/*",
        error: "Remote tool images are not loaded automatically.",
      },
    ]);
  });

  it("deduplicates repeated inline representations and uses activity fallback IDs", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    expect(
      extractToolResultImages(
        {
          result: {
            content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
            generatedImage: { image_url: dataUrl },
          },
        },
        "Snapshot",
        "activity-without-tool-id",
      ),
    ).toEqual([
      {
        id: "activity-without-tool-id:content:0",
        name: "Snapshot image",
        mimeType: "image/png",
        previewUrl: dataUrl,
      },
    ]);
  });

  it("caps the number of images extracted from one tool result", () => {
    const images = extractToolResultImages(
      {
        id: "many-images",
        result: {
          content: Array.from({ length: 10 }, () => ({
            type: "image",
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          })),
        },
      },
      "Snapshot",
      "activity-many-images",
    );

    expect(images.at(-1)).toEqual({
      id: "many-images:overflow",
      name: "Additional images omitted",
      mimeType: "image/*",
      error: "2 additional images were omitted.",
    });
  });

  it("renders a fallback instead of decoding oversized inline images", () => {
    const oversizedPng = `iVBORw0KGgoA${"A".repeat(12 * 1024 * 1024)}`;
    expect(
      extractToolResultImages(
        {
          id: "oversized-image",
          result: {
            content: [{ type: "image", data: oversizedPng, mimeType: "image/png" }],
          },
        },
        "Snapshot",
        "activity-oversized",
      ),
    ).toEqual([
      {
        id: "oversized-image:content:0",
        name: "Snapshot image",
        mimeType: "image/png",
        error: "Image omitted because it is larger than 8 MB.",
      },
    ]);
  });

  it("redacts inline image payloads from expanded tool JSON", () => {
    const display = stringifyToolDataForDisplay({
      type: "mcpToolCall",
      result: {
        content: [
          { type: "text", text: "visible metadata" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
      },
    });

    expect(display).toContain("visible metadata");
    expect(display).toContain("[image/png image data omitted; 12 characters]");
    expect(display).not.toContain("iVBORw0KGgo=");
  });

  it("keeps failed image generation errors visible in expanded tool JSON", () => {
    const display = stringifyToolDataForDisplay({
      type: "imageGeneration",
      status: "failed",
      result: "generation failed: safety policy",
    });

    expect(display).toContain("generation failed: safety policy");
    expect(display).not.toContain("image data omitted");
  });

  it("redacts rejected imageGeneration data URLs instead of failing open", () => {
    const svgDataUrl =
      "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const display = stringifyToolDataForDisplay({
      type: "imageGeneration",
      status: "completed",
      result: svgDataUrl,
    });

    expect(display).toContain("[image image data omitted;");
    expect(display).not.toContain(svgDataUrl);
    expect(display).not.toContain("image/svg+xml");
  });

  it("rejects MIME/signature mismatches during extraction", () => {
    const images = extractToolResultImages(
      {
        id: "spoofed-call",
        type: "mcpToolCall",
        tool: "preview_snapshot",
        result: {
          // JPEG magic bytes labeled as PNG must not render.
          content: [{ type: "image", data: "/9j/AAAA", mimeType: "image/png" }],
        },
      },
      "Snapshot",
      "activity-spoofed",
    );

    expect(images).toEqual([
      {
        id: "spoofed-call:content:0",
        name: "Snapshot image",
        mimeType: "image/png",
        error: "Image data is invalid.",
      },
    ]);
  });
});
