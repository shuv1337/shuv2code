import { EventId, type OrchestrationThreadActivity } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_SNAPSHOT_COMPACTION_MARKER,
  projectActivityPayload,
} from "./ActivityPayloadProjection.ts";

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

describe("projectActivityPayload", () => {
  it("compacts preview semantics while retaining screenshots and MCP metadata", () => {
    const snapshotText = "snapshot-payload".repeat(10_000);
    const projected = projectActivityPayload({
      id: EventId.make("preview-snapshot-activity"),
      createdAt: "2026-08-01T00:00:00.000Z",
      kind: "tool.completed",
      summary: "shuv2code · preview_snapshot",
      tone: "tool",
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        data: {
          completedAtMs: 1234,
          item: {
            type: "mcpToolCall",
            id: "preview-call-1",
            server: "shuv2code",
            tool: "preview_snapshot",
            arguments: { tabId: "tab_1", includeScreenshot: true },
            durationMs: 125,
            status: "completed",
            error: { code: "partial_snapshot", message: "One frame was skipped." },
            result: {
              content: [
                "ignored",
                { type: "text", text: snapshotText },
                {
                  type: "image",
                  data: "iVBORw0KGgo=",
                  mimeType: "image/png",
                  name: "Browser screenshot",
                },
              ],
              structuredContent: { snapshotText },
            },
          },
        },
      },
      turnId: null,
    });

    expect(projected.payload).toEqual({
      itemType: "mcp_tool_call",
      status: "completed",
      data: {
        completedAtMs: 1234,
        item: {
          type: "mcpToolCall",
          id: "preview-call-1",
          server: "shuv2code",
          tool: "preview_snapshot",
          arguments: { tabId: "tab_1", includeScreenshot: true },
          durationMs: 125,
          status: "completed",
          error: { code: "partial_snapshot", message: "One frame was skipped." },
          result: {
            content: [
              {
                type: "text",
                text: PREVIEW_SNAPSHOT_COMPACTION_MARKER,
              },
              {
                type: "image",
                data: "iVBORw0KGgo=",
                mimeType: "image/png",
                name: "Browser screenshot",
              },
            ],
          },
        },
      },
    });
    expect(projectActivityPayload(projected)).toBe(projected);
  });

  it("leaves other MCP tool results unchanged", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("other-mcp-activity"),
      createdAt: "2026-08-01T00:00:00.000Z",
      kind: "tool.completed",
      summary: "other · read",
      tone: "tool",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            server: "other",
            tool: "read",
            result: { content: [{ type: "text", text: "full result" }] },
          },
        },
      },
      turnId: null,
    };

    expect(projectActivityPayload(activity)).toBe(activity);
  });

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
