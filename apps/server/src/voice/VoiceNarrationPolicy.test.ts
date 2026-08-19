import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@shuv2code/contracts";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  decideVoiceNarration,
  initialVoiceNarrationRuntimeState,
  resolveVoiceNarrationPolicy,
  voiceNarrationCheckpoint,
} from "./VoiceNarrationPolicy.ts";

const toolEvent = (
  type: "item.started" | "item.updated" | "item.completed",
  input: {
    readonly itemType?: "command_execution" | "mcp_tool_call";
    readonly title?: string;
  } = {},
): ProviderRuntimeEvent => ({
  type,
  eventId: EventId.make(`event-${type}`),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  itemId: RuntimeItemId.make("tool-1"),
  createdAt: "2026-08-15T04:00:00.000Z",
  payload: {
    itemType: input.itemType ?? "mcp_tool_call",
    ...(input.title === undefined ? {} : { title: input.title }),
  },
});

describe("VoiceNarrationPolicy", () => {
  it("keeps quiet calls free of routine progress narration", () => {
    const policy = resolveVoiceNarrationPolicy("quiet");
    assert.strictEqual(policy.silenceIntervalMs, null);
    assert.include(policy.prompt.join("\n"), "Keep routine tool progress quiet");
    assert.notInclude(policy.prompt.join("\n"), "roughly thirty seconds");
  });

  it("preserves the existing balanced thirty-second cadence", () => {
    const policy = resolveVoiceNarrationPolicy("balanced");
    assert.strictEqual(policy.silenceIntervalMs, 30_000);
    assert.include(policy.prompt.join("\n"), "roughly thirty seconds");
    assert.include(policy.prompt.join("\n"), "commentary updates");
  });

  it("uses shorter tool-aware conversational narration", () => {
    const policy = resolveVoiceNarrationPolicy("conversational");
    assert.strictEqual(policy.silenceIntervalMs, 15_000);
    assert.include(policy.prompt.join("\n"), "roughly fifteen seconds");
    assert.include(policy.prompt.join("\n"), "meaningful tool calls");
    assert.include(policy.prompt.join("\n"), "never read raw tool names");
  });

  it("turns canonical tool lifecycle events into bounded semantic checkpoints", () => {
    expect(
      voiceNarrationCheckpoint(
        toolEvent("item.started", { itemType: "mcp_tool_call", title: "Search repository" }),
      ),
    ).toEqual({
      key: "tool-1:item.started",
      text: "I’m working through the next step now.",
    });
    expect(
      voiceNarrationCheckpoint(toolEvent("item.completed", { itemType: "command_execution" })),
    ).toEqual({
      key: "tool-1:item.completed",
      text: "That check has finished; I’m working through the result now.",
    });
  });

  it("never speaks provider-supplied tool titles or command detail", () => {
    const title = "Run curl with secret-token-123";
    const checkpoint = voiceNarrationCheckpoint(
      toolEvent("item.started", { itemType: "command_execution", title }),
    );
    assert.isNotNull(checkpoint);
    assert.notInclude(checkpoint.text, title);
    assert.strictEqual(checkpoint.text, "I’m running the next check now.");
  });

  it("waits for the configured silence interval and deduplicates unchanged checkpoints", () => {
    const policy = resolveVoiceNarrationPolicy("balanced");
    const pending = voiceNarrationCheckpoint(toolEvent("item.started"));
    assert.isNotNull(pending);
    const state = { ...initialVoiceNarrationRuntimeState(1_000), pending };

    expect(decideVoiceNarration({ policy, state, nowMs: 30_999 })).toMatchObject({
      speak: false,
      reason: "cooldown",
    });
    expect(decideVoiceNarration({ policy, state, nowMs: 31_000 })).toMatchObject({
      speak: true,
      reason: "speak",
    });
    expect(
      decideVoiceNarration({
        policy,
        state: { ...state, lastNarratedKey: pending.key },
        nowMs: 90_000,
      }),
    ).toMatchObject({ speak: false, reason: "duplicate" });
    expect(
      decideVoiceNarration({
        policy,
        state: {
          ...state,
          pending: { ...pending, key: "another-tool:item.started" },
          lastNarratedText: pending.text,
        },
        nowMs: 90_000,
      }),
    ).toMatchObject({ speak: false, reason: "duplicate" });
  });
});
