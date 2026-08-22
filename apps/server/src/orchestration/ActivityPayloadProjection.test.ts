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

  it("slims non-preview MCP tool results down to metadata and a text summary", () => {
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

    expect(projectActivityPayload(activity).payload).toEqual({
      itemType: "mcp_tool_call",
      data: {
        item: {
          type: "mcpToolCall",
          server: "other",
          tool: "read",
          result: { content: "full result" },
        },
      },
    });
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
function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload agent-field survival", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("keeps OpenCode V2 tool names and inputs needed for visible call details", () => {
    const shell = projectActivityPayload(
      activity({
        itemType: "command_execution",
        status: "completed",
        data: {
          tool: "shell",
          input: { command: "pwd" },
          sessionID: "ses_private",
          assistantMessageID: "msg_private",
          callID: "call_private",
          content: [{ type: "text", text: "/workspace\n" }],
        },
      }),
    );
    const execute = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        status: "completed",
        data: {
          tool: "execute",
          input: { code: "return await tools.shuv2code.thread_control_request({})" },
          sessionID: "ses_private",
        },
      }),
    );

    expect(shell.payload).toEqual({
      itemType: "command_execution",
      status: "completed",
      data: {
        tool: "shell",
        input: { command: "pwd" },
        rawOutput: { content: "/workspace" },
      },
    });
    expect(execute.payload).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      data: {
        tool: "execute",
        input: { code: "return await tools.shuv2code.thread_control_request({})" },
      },
    });
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});
