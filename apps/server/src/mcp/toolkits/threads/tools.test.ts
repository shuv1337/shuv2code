import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import {
  ControllerThreadTools,
  ThreadCreateInput,
  ThreadSendInput,
  ThreadToolkit,
} from "./tools.ts";

it("exports exactly the five controller thread tools", () => {
  expect(Object.keys(ThreadToolkit.tools).sort()).toEqual([
    "thread_create",
    "thread_get",
    "thread_interrupt",
    "thread_list",
    "thread_send",
  ]);
  expect(ControllerThreadTools).toHaveLength(5);
});

it("does not accept model-supplied action or permission authority", () => {
  for (const tool of ControllerThreadTools) {
    const serialized = JSON.stringify(Tool.getJsonSchema(tool));
    expect(serialized).not.toContain('"voiceActionId"');
    expect(serialized).not.toContain('"idempotencyKey"');
    expect(serialized).not.toContain('"runtimeMode"');
    expect(serialized).not.toContain('"providerInstanceId"');
  }
});

it.effect("requires an exact start-versus-steer precondition", () =>
  Effect.gen(function* () {
    const steer = yield* Schema.decodeUnknownEffect(ThreadSendInput)({
      threadId: "thread-1",
      text: "Focus on the failing tests.",
      disposition: "steer",
      expectedTurnId: "turn-1",
    });
    expect(steer).toMatchObject({ disposition: "steer", expectedTurnId: "turn-1" });

    yield* Schema.decodeUnknownEffect(ThreadSendInput)({
      threadId: "thread-1",
      text: "Start now.",
      disposition: "start",
      expectedTurnId: "turn-1",
    }).pipe(Effect.flip);
  }),
);

it.effect("trims creation text and rejects an empty instruction", () =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(ThreadCreateInput)({
      projectId: " project-1 ",
      initialInstruction: " Investigate the failing tests. ",
    });
    expect(input).toEqual({
      projectId: "project-1",
      initialInstruction: "Investigate the failing tests.",
    });

    yield* Schema.decodeUnknownEffect(ThreadCreateInput)({
      projectId: "project-1",
      initialInstruction: "   ",
    }).pipe(Effect.flip);
  }),
);

it("marks read and mutation annotations accurately", () => {
  const annotations = Object.fromEntries(
    ControllerThreadTools.map((tool) => [
      tool.name,
      {
        readonly: Context.get(tool.annotations, Tool.Readonly),
        destructive: Context.get(tool.annotations, Tool.Destructive),
      },
    ]),
  );
  expect(annotations.thread_list).toEqual({ readonly: true, destructive: false });
  expect(annotations.thread_get).toEqual({ readonly: true, destructive: false });
  expect(annotations.thread_create).toEqual({ readonly: false, destructive: true });
  expect(annotations.thread_send).toEqual({ readonly: false, destructive: true });
  expect(annotations.thread_interrupt).toEqual({ readonly: false, destructive: true });
});
