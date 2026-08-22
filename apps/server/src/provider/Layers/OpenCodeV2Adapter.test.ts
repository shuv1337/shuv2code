import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@shuv2code/contracts";
import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import type { OpenCodeV2Client, OpenCodeV2Event } from "../opencodeV2Client.ts";

import {
  decodeOpenCodeV2Form,
  decodeOpenCodeV2Permission,
  decodeOpenCodeV2PermissionReply,
  decodeOpenCodeV2ResumeCursor,
  makeOpenCodeV2Adapter,
  mapOpenCodeV2FormToQuestions,
  openCodeV2EventSessionId,
  toOpenCodeV2FormAnswer,
} from "./OpenCodeV2Adapter.ts";

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("not used"),
  connectToOpenCodeServer: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      exitCode: null,
      external: true,
      protocol: "v2",
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () => Effect.die("not used"),
  loadInventoryFromCli: () => Effect.die("not used"),
};

const OPEN_CODE_V2_SETTINGS = {
  enabled: true,
  binaryPath: "opencode",
  serverUrl: "http://127.0.0.1:4301",
  serverPassword: "",
  customModels: [],
} as const;

function makeAdoptionClient(input: {
  readonly messages: () => Promise<unknown>;
  readonly events: ReadonlyArray<OpenCodeV2Event>;
}): OpenCodeV2Client {
  return {
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "server.connected" };
          yield* input.events;
          await new Promise<never>(() => undefined);
        },
      }),
    },
    session: {
      get: async (sessionID: string) => ({ id: sessionID }),
      messages: input.messages,
    },
    form: { list: async () => [] },
    permission: { list: async () => [] },
  } as unknown as OpenCodeV2Client;
}

function runAdoptedToolCompletion(input: {
  readonly messages: () => Promise<unknown>;
  readonly expectedTitle: string;
  readonly expectedEventCount: number;
}) {
  return Effect.gen(function* () {
    const threadId = ThreadId.make(`thread-${input.expectedTitle}`);
    const client = makeAdoptionClient({
      messages: input.messages,
      events: [
        {
          type: "session.tool.success",
          data: { sessionID: "ses_adopted", callID: "call_1" },
        },
      ],
    });
    const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
      clientFactory: () => client,
    });
    const eventsFiber = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId && event.type.startsWith("item.")),
      Stream.take(input.expectedEventCount),
      Stream.runCollect,
      Effect.forkChild,
    );

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("opencodeV2"),
      threadId,
      runtimeMode: "full-access",
      resumeCursor: {
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: "ses_adopted",
      },
    });

    const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
    NodeAssert.equal(events.length, input.expectedEventCount);
    for (const event of events) {
      if (event.type === "item.started" || event.type === "item.completed") {
        NodeAssert.equal(event.payload.title, input.expectedTitle);
      }
    }
  }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer));
}

const OpenCodeRuntimeTestDoubleLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble);
const OpenCodeV2AdapterTestLayer = Layer.merge(
  OpenCodeRuntimeTestDoubleLayer,
  ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(Layer.provideMerge(NodeServices.layer)),
);

describe("OpenCodeV2Adapter terminal state", () => {
  it.effect("removes the active turn from the session after successful execution", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-successful-execution");
      let completeExecution: (() => void) | undefined;
      const executionCompleted = new Promise<void>((resolve) => {
        completeExecution = resolve;
      });
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await executionCompleted;
              yield {
                type: "session.execution.succeeded",
                data: { sessionID: "ses_successful_execution" },
              };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_successful_execution" }),
          prompt: async () => {
            completeExecution?.();
          },
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const completedEvent = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "complete successfully",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencodeV2"),
          model: "openai/gpt-5.6-sol",
          options: [],
        },
      });
      yield* Fiber.join(completedEvent).pipe(Effect.timeout("1 second"));

      const session = (yield* adapter.listSessions())[0];
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.deepEqual(session?.resumeCursor, {
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: "ses_successful_execution",
      });
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("settles a resumed turn that is no longer active upstream", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-resumed-idle");
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          get: async () => ({ id: "ses_resumed_idle" }),
          messages: async () => ({ data: [], cursor: {} }),
          active: async () => ({}),
          wait: async () => undefined,
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const completedEvent = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "turn.completed" &&
            String(event.turnId) === "opencode2-turn-resumed-idle",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_resumed_idle",
          activeTurnId: "opencode2-turn-resumed-idle",
        },
      });

      yield* Fiber.join(completedEvent).pipe(Effect.timeout("1 second"));
      NodeAssert.equal(session.status, "ready");
      NodeAssert.equal(session.activeTurnId, undefined);
      NodeAssert.deepEqual(session.resumeCursor, {
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: "ses_resumed_idle",
      });
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("keeps a resumed turn active until the upstream wait completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-resumed-running");
      let finishExecution: (() => void) | undefined;
      const executionFinished = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          get: async () => ({ id: "ses_resumed_running" }),
          messages: async () => ({ data: [], cursor: {} }),
          active: async () => ({ ses_resumed_running: { type: "running" } }),
          wait: async () => executionFinished,
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const completedEvent = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "turn.completed" &&
            String(event.turnId) === "opencode2-turn-resumed-running",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_resumed_running",
          activeTurnId: "opencode2-turn-resumed-running",
        },
      });

      NodeAssert.equal(session.status, "running");
      NodeAssert.equal(String(session.activeTurnId), "opencode2-turn-resumed-running");
      finishExecution?.();
      yield* Fiber.join(completedEvent).pipe(Effect.timeout("1 second"));
      const settledSession = (yield* adapter.listSessions())[0];
      NodeAssert.equal(settledSession?.status, "ready");
      NodeAssert.equal(settledSession?.activeTurnId, undefined);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter model selection", () => {
  it.effect("switches the upstream session to the selected agent and model before prompting", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-selected-model");
      const calls: Array<readonly [string, unknown]> = [];
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_selected_model" }),
          switchAgent: async (_sessionID: string, agent: string) => {
            calls.push(["agent", agent]);
          },
          switchModel: async (_sessionID: string, model: unknown) => {
            calls.push(["model", model]);
          },
          prompt: async (_sessionID: string, body: unknown) => {
            calls.push(["prompt", body]);
          },
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "use the selected model",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencodeV2"),
          model: "openai/gpt-5.6-sol",
          options: [
            { id: "variant", value: "high" },
            { id: "agent", value: "build" },
          ],
        },
      });

      NodeAssert.deepEqual(calls, [
        ["agent", "build"],
        ["model", { providerID: "openai", id: "gpt-5.6-sol", variant: "high" }],
        ["prompt", { text: "use the selected model" }],
      ]);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter interruption", () => {
  it.effect("cancels pending forms and accepts a new turn after interruption", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-interrupt-form");
      const promptCalls: string[] = [];
      const cancelledForms: string[] = [];
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_interrupt_form" }),
          switchModel: async () => undefined,
          prompt: async (_sessionID: string, input: { readonly text: string }) => {
            promptCalls.push(input.text);
          },
          interrupt: async () => undefined,
        },
        form: {
          list: async () => [
            {
              id: "frm_interrupt_form",
              sessionID: "ses_interrupt_form",
              fields: [{ key: "q0", type: "string", title: "Question" }],
            },
          ],
          cancel: async (_sessionID: string, formID: string) => {
            cancelledForms.push(formID);
          },
        },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencodeV2"),
        model: "openai/gpt-5.6-sol",
        options: [],
      };
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first",
        attachments: [],
        modelSelection,
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);

      const session = (yield* adapter.listSessions())[0];
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.deepEqual(cancelledForms, ["frm_interrupt_form"]);

      yield* adapter.sendTurn({
        threadId,
        input: "second",
        attachments: [],
        modelSelection,
      });
      NodeAssert.deepEqual(promptCalls, ["first", "second"]);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter adopted tool names", () => {
  it.effect("recovers a projected tool name before mapping a terminal event", () =>
    runAdoptedToolCompletion({
      messages: async (_sessionID?: string, options?: { readonly cursor?: string }) =>
        options?.cursor === "older-page"
          ? {
              data: [
                {
                  type: "assistant",
                  content: [{ type: "tool", id: "call_1", name: "bash" }],
                },
              ],
              cursor: {},
            }
          : { data: [], cursor: { next: "older-page" } },
      expectedTitle: "bash",
      expectedEventCount: 1,
    }),
  );

  it.effect("uses the generic tool name when projected messages are empty", () =>
    runAdoptedToolCompletion({
      messages: async () => ({ data: [], cursor: {} }),
      expectedTitle: "tool",
      expectedEventCount: 2,
    }),
  );

  it.effect("uses the generic tool name when projected-message recovery fails", () =>
    runAdoptedToolCompletion({
      messages: async () => {
        throw new Error("messages unavailable");
      },
      expectedTitle: "tool",
      expectedEventCount: 2,
    }),
  );
});

describe("OpenCodeV2Adapter tool lifecycle", () => {
  it.effect("maps the current ShuvCode callID field across a complete tool lifecycle", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-tool-call-id");
      const client = makeAdoptionClient({
        messages: async () => ({ data: [], cursor: {} }),
        events: [
          {
            type: "session.tool.input.started",
            data: {
              sessionID: "ses_adopted",
              assistantMessageID: "msg_1",
              callID: "call_1",
              name: "bash",
            },
          },
          {
            type: "session.tool.called",
            data: {
              sessionID: "ses_adopted",
              assistantMessageID: "msg_1",
              callID: "call_1",
              input: { command: "pwd" },
            },
          },
          {
            type: "session.tool.success",
            data: {
              sessionID: "ses_adopted",
              assistantMessageID: "msg_1",
              callID: "call_1",
              content: [{ type: "text", text: "/workspace" }],
            },
          },
        ],
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type.startsWith("item.")),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_adopted",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => ({
          type: event.type,
          itemId: event.itemId,
          itemType: "itemType" in event.payload ? event.payload.itemType : undefined,
          status: "status" in event.payload ? event.payload.status : undefined,
          title: "title" in event.payload ? event.payload.title : undefined,
        })),
        [
          {
            type: "item.started",
            itemId: "call_1",
            itemType: "command_execution",
            status: "inProgress",
            title: "bash",
          },
          {
            type: "item.updated",
            itemId: "call_1",
            itemType: "command_execution",
            status: "inProgress",
            title: "bash",
          },
          {
            type: "item.completed",
            itemId: "call_1",
            itemType: "command_execution",
            status: "completed",
            title: "bash",
          },
        ],
      );
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter reasoning lifecycle", () => {
  it.effect("keeps reasoning and assistant text distinct and completes plaintext reasoning", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-reasoning");
      const client = makeAdoptionClient({
        messages: async () => ({ data: [], cursor: {} }),
        events: [
          {
            type: "session.reasoning.started",
            data: { sessionID: "ses_reasoning", assistantMessageID: "msg_1", ordinal: 0 },
          },
          {
            type: "session.reasoning.delta",
            data: {
              sessionID: "ses_reasoning",
              assistantMessageID: "msg_1",
              ordinal: 0,
              delta: "Inspect",
            },
          },
          {
            type: "session.reasoning.ended",
            data: {
              sessionID: "ses_reasoning",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: "Inspect adapter",
              state: { reasoningField: "reasoning_content" },
            },
          },
          {
            type: "session.text.started",
            data: { sessionID: "ses_reasoning", assistantMessageID: "msg_1", ordinal: 0 },
          },
          {
            type: "session.text.ended",
            data: {
              sessionID: "ses_reasoning",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: "Done.",
            },
          },
          {
            type: "session.reasoning.started",
            data: { sessionID: "ses_reasoning", assistantMessageID: "msg_2", ordinal: 0 },
          },
          {
            type: "session.reasoning.ended",
            data: {
              sessionID: "ses_reasoning",
              assistantMessageID: "msg_2",
              ordinal: 0,
              text: "Use the durable full-value boundary.",
            },
          },
        ],
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "item.started" ||
              event.type === "content.delta" ||
              event.type === "item.completed"),
        ),
        Stream.take(10),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_reasoning",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => ({
          type: event.type,
          itemId: event.itemId,
          itemType: "itemType" in event.payload ? event.payload.itemType : undefined,
          streamKind: "streamKind" in event.payload ? event.payload.streamKind : undefined,
          delta: "delta" in event.payload ? event.payload.delta : undefined,
          detail: "detail" in event.payload ? event.payload.detail : undefined,
        })),
        [
          {
            type: "item.started",
            itemId: "msg_1:reasoning_text:0",
            itemType: "reasoning",
            streamKind: undefined,
            delta: undefined,
            detail: undefined,
          },
          {
            type: "content.delta",
            itemId: "msg_1:reasoning_text:0",
            itemType: undefined,
            streamKind: "reasoning_text",
            delta: "Inspect",
            detail: undefined,
          },
          {
            type: "content.delta",
            itemId: "msg_1:reasoning_text:0",
            itemType: undefined,
            streamKind: "reasoning_text",
            delta: " adapter",
            detail: undefined,
          },
          {
            type: "item.completed",
            itemId: "msg_1:reasoning_text:0",
            itemType: "reasoning",
            streamKind: undefined,
            delta: undefined,
            detail: "Inspect adapter",
          },
          {
            type: "item.started",
            itemId: "msg_1:assistant_text:0",
            itemType: "assistant_message",
            streamKind: undefined,
            delta: undefined,
            detail: undefined,
          },
          {
            type: "content.delta",
            itemId: "msg_1:assistant_text:0",
            itemType: undefined,
            streamKind: "assistant_text",
            delta: "Done.",
            detail: undefined,
          },
          {
            type: "item.completed",
            itemId: "msg_1:assistant_text:0",
            itemType: "assistant_message",
            streamKind: undefined,
            delta: undefined,
            detail: "Done.",
          },
          {
            type: "item.started",
            itemId: "msg_2:reasoning_text:0",
            itemType: "reasoning",
            streamKind: undefined,
            delta: undefined,
            detail: undefined,
          },
          {
            type: "content.delta",
            itemId: "msg_2:reasoning_text:0",
            itemType: undefined,
            streamKind: "reasoning_text",
            delta: "Use the durable full-value boundary.",
            detail: undefined,
          },
          {
            type: "item.completed",
            itemId: "msg_2:reasoning_text:0",
            itemType: "reasoning",
            streamKind: undefined,
            delta: undefined,
            detail: "Use the durable full-value boundary.",
          },
        ],
      );
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("drops empty encrypted-only reasoning completions", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-encrypted-reasoning");
      const client = makeAdoptionClient({
        messages: async () => ({ data: [], cursor: {} }),
        events: [
          {
            type: "session.reasoning.started",
            data: {
              sessionID: "ses_encrypted",
              assistantMessageID: "msg_1",
              ordinal: 0,
              state: { reasoningEncryptedContent: "ciphertext" },
            },
          },
          {
            type: "session.reasoning.ended",
            data: {
              sessionID: "ses_encrypted",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: "",
              state: { reasoningEncryptedContent: "ciphertext" },
            },
          },
          {
            type: "session.text.started",
            data: { sessionID: "ses_encrypted", assistantMessageID: "msg_1", ordinal: 0 },
          },
          {
            type: "session.text.ended",
            data: {
              sessionID: "ses_encrypted",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: "Done.",
            },
          },
        ],
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "item.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_encrypted",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events.length, 1);
      NodeAssert.equal(events[0]?.type, "item.completed");
      if (events[0]?.type === "item.completed") {
        NodeAssert.equal(events[0].payload.itemType, "assistant_message");
      }
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter form mapping", () => {
  const form = {
    id: "frm_1",
    sessionID: "ses_live",
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Scope",
        description: "What scope?",
        options: [{ value: "small", label: "Small", description: "Small change" }],
      },
      {
        key: "q1",
        type: "multiselect",
        title: "Areas",
        options: [
          { value: "server", label: "Server" },
          { value: "web", label: "Web" },
        ],
      },
      { key: "ignored", type: "boolean", title: "Unsupported" },
    ],
  } as const;

  it("finds a nested form session id in live SSE envelopes", () => {
    NodeAssert.equal(
      openCodeV2EventSessionId({
        type: "form.created",
        data: { form: { id: "frm_1", sessionID: "ses_live", fields: [] } },
      }),
      "ses_live",
    );
  });

  it("uses stable field keys and preserves custom-only string questions", () => {
    NodeAssert.deepEqual(mapOpenCodeV2FormToQuestions(form), [
      {
        id: "q0",
        header: "Scope",
        question: "What scope?",
        options: [{ label: "Small", description: "Small change" }],
        multiSelect: false,
      },
      {
        id: "q1",
        header: "Areas",
        question: "Areas",
        options: [
          { label: "Server", description: "Server" },
          { label: "Web", description: "Web" },
        ],
        multiSelect: true,
      },
    ]);
  });

  it("submits mapped fields only", () => {
    NodeAssert.deepEqual(
      toOpenCodeV2FormAnswer(form, {
        q0: "custom scope",
        q1: ["Server", "Web"],
        stale: "do not submit",
      }),
      {
        q0: "custom scope",
        q1: ["server", "web"],
      },
    );
  });

  it("maps scalar labels and missing option values while preserving custom text", () => {
    NodeAssert.deepEqual(
      toOpenCodeV2FormAnswer(
        {
          ...form,
          fields: [
            ...form.fields,
            {
              key: "q2",
              type: "string",
              options: [{ label: "Keep label" }],
            },
          ],
        },
        {
          q0: "Small",
          q1: ["Server", "custom area"],
          q2: "Keep label",
        },
      ),
      {
        q0: "small",
        q1: ["server", "custom area"],
        q2: "Keep label",
      },
    );
  });
});

describe("OpenCodeV2Adapter command payload decoding", () => {
  it.effect("decodes valid form, permission, and resume payloads", () =>
    Effect.gen(function* () {
      const decodedForm = yield* decodeOpenCodeV2Form({
        id: " frm_1 ",
        sessionID: " ses_live ",
        fields: [{ key: " scope ", options: [{ label: "Small", value: "small" }] }],
      });
      const decodedPermission = yield* decodeOpenCodeV2Permission({
        id: " perm_1 ",
        action: "bash",
        resources: ["pwd"],
      });
      const decodedResume = yield* decodeOpenCodeV2ResumeCursor({
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: " ses_live ",
      });

      NodeAssert.equal(decodedForm.id, "frm_1");
      NodeAssert.equal(decodedForm.fields?.[0]?.key, "scope");
      NodeAssert.equal(decodedPermission.id, "perm_1");
      NodeAssert.equal(decodedResume.sessionId, "ses_live");
    }),
  );

  it.effect("rejects missing or invalid command-critical identifiers and replies", () =>
    Effect.gen(function* () {
      const exits = yield* Effect.all([
        Effect.exit(decodeOpenCodeV2Form({ sessionID: "ses_live" })),
        Effect.exit(decodeOpenCodeV2Permission({ action: "bash" })),
        Effect.exit(decodeOpenCodeV2PermissionReply({ requestID: "", reply: "once" })),
        Effect.exit(
          decodeOpenCodeV2ResumeCursor({
            kind: "opencode-v2",
            schemaVersion: 1,
            sessionId: " ",
          }),
        ),
      ]);

      for (const exit of exits) {
        NodeAssert.equal(exit._tag, "Failure");
      }
    }),
  );
});
