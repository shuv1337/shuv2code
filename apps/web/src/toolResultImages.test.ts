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
});
