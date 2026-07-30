import { EventId, type OrchestrationThreadActivity } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function imageActivity(item: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: EventId.make("image-activity"),
    createdAt: "2026-07-30T00:00:00.000Z",
    kind: "tool.completed",
    summary: "Image result",
    tone: "tool",
    payload: { itemType: "image_view", data: { item, ignored: "large provider payload" } },
    turnId: null,
  };
}

describe("projectActivityPayload image results", () => {
  it("preserves the native image generation fields required by the web renderer", () => {
    const projected = projectActivityPayload(
      imageActivity({
        id: "generation-1",
        type: "imageGeneration",
        result: "iVBORw0KGgo=",
        savedPath: "/workspace/generated.png",
        status: "completed",
        revisedPrompt: "discarded",
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "image_view",
      data: {
        item: {
          id: "generation-1",
          type: "imageGeneration",
          result: "iVBORw0KGgo=",
          savedPath: "/workspace/generated.png",
          status: "completed",
        },
      },
    });
  });

  it("preserves the native workspace image path required by the web renderer", () => {
    const projected = projectActivityPayload(
      imageActivity({ id: "view-1", type: "imageView", path: "/workspace/screenshot.png" }),
    );

    expect(projected.payload).toEqual({
      itemType: "image_view",
      data: {
        item: { id: "view-1", type: "imageView", path: "/workspace/screenshot.png" },
        files: [{ path: "/workspace/screenshot.png" }],
      },
    });
  });
});
