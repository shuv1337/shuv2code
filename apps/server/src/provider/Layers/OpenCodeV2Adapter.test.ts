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
  readonly event: OpenCodeV2Event;
}): OpenCodeV2Client {
  return {
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "server.connected" };
          yield input.event;
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
      event: {
        type: "session.tool.success",
        data: { sessionID: "ses_adopted", id: "call_1" },
      },
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
