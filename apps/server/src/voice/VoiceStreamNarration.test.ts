import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@shuv2code/contracts";

import {
  initialVoiceStreamNarrationState,
  reduceVoiceStreamNarration,
} from "./VoiceStreamNarration.ts";

const base = {
  eventId: EventId.make("event"),
  provider: ProviderDriverKind.make("opencode"),
  threadId: ThreadId.make("thread"),
  turnId: TurnId.make("turn"),
  itemId: RuntimeItemId.make("message"),
  createdAt: "2026-08-15T00:00:00.000Z",
} as const;

const delta = (
  text: string,
  streamKind: "assistant_text" | "reasoning_summary_text" = "assistant_text",
): ProviderRuntimeEvent => ({
  ...base,
  type: "content.delta",
  payload: { streamKind, delta: text },
});

describe("VoiceStreamNarration", () => {
  it("waits for two sentences before emitting the first assistant chunk", () => {
    const first = reduceVoiceStreamNarration(
      initialVoiceStreamNarrationState(),
      delta("I found the transport boundary. "),
    );
    assert.deepStrictEqual(first.chunks, []);
    const second = reduceVoiceStreamNarration(
      first.state,
      delta("Now I’m checking the provider-neutral event path. More follows"),
    );
    assert.deepStrictEqual(
      second.chunks.map((chunk) => chunk.text),
      ["I found the transport boundary. Now I’m checking the provider-neutral event path."],
    );
  });

  it("uses a reasoning summary only when a tool boundary has no assistant update", () => {
    const reasoning = reduceVoiceStreamNarration(
      initialVoiceStreamNarrationState(),
      delta("Checking the adapter boundary before changing the queue.", "reasoning_summary_text"),
    );
    const tool = reduceVoiceStreamNarration(reasoning.state, {
      ...base,
      type: "item.started",
      payload: { itemType: "command_execution", status: "inProgress" },
    });
    assert.deepStrictEqual(
      tool.chunks.map((chunk) => chunk.source),
      ["reasoning-summary"],
    );

    const assistant = reduceVoiceStreamNarration(
      initialVoiceStreamNarrationState(),
      delta("I found the boundary. I’m checking the queue now."),
    );
    const assistantThenTool = reduceVoiceStreamNarration(assistant.state, {
      ...base,
      type: "item.started",
      payload: { itemType: "command_execution", status: "inProgress" },
    });
    assert.deepStrictEqual(assistantThenTool.chunks, []);
  });

  it("flushes a short final remainder and strips code and table payloads", () => {
    const partial = reduceVoiceStreamNarration(
      initialVoiceStreamNarrationState(),
      delta("Done with the provider split.\n\n```ts\nconst secret = true\n```\n| raw | table |"),
    );
    const complete = reduceVoiceStreamNarration(partial.state, {
      ...base,
      type: "item.completed",
      payload: { itemType: "assistant_message", status: "completed" },
    });
    assert.deepStrictEqual(
      complete.chunks.map((chunk) => chunk.text),
      ["Done with the provider split."],
    );
  });

  it("buffers assistant commentary until completion in final-only mode", () => {
    const partial = reduceVoiceStreamNarration(
      initialVoiceStreamNarrationState(),
      delta("I found the provider boundary. I’m checking the durable result now."),
      "final-only",
    );
    assert.deepStrictEqual(partial.chunks, []);
    const complete = reduceVoiceStreamNarration(
      partial.state,
      {
        ...base,
        type: "item.completed",
        payload: { itemType: "assistant_message", status: "completed" },
      },
      "final-only",
    );
    assert.deepStrictEqual(
      complete.chunks.map((chunk) => chunk.text),
      ["I found the provider boundary."],
    );
  });
});
