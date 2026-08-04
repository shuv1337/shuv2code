import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as itEffect } from "@effect/vitest";
import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

const TestLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "shuv2code-normalizer-pdf-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

function pdfTurn(dataUrl = "data:application/pdf;base64,JVBERi0xLjcK") {
  return decodeClientCommand({
    type: "thread.turn.start",
    commandId: "cmd-pdf-1",
    threadId: "thread-pdf-1",
    message: {
      messageId: "msg-pdf-1",
      role: "user",
      text: "Read this",
      attachments: [
        {
          type: "file",
          name: "guide.pdf",
          mimeType: "application/pdf",
          sizeBytes: 9,
          dataUrl,
        },
      ],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

itEffect.effect("persists a valid PDF upload as a canonical file attachment", () =>
  Effect.gen(function* () {
    const command = yield* normalizeDispatchCommand(pdfTurn());
    assert.strictEqual(command.type, "thread.turn.start");
    if (command.type !== "thread.turn.start") return;
    const attachment = command.message.attachments[0];
    assert.strictEqual(attachment?.type, "file");
    if (!attachment || attachment.type !== "file") return;

    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const bytes = yield* fileSystem.readFile(`${config.attachmentsDir}/${attachment.id}.pdf`);
    assert.strictEqual(Buffer.from(bytes).toString("ascii"), "%PDF-1.7\n");
  }).pipe(Effect.provide(TestLayer)),
);

itEffect.effect("rejects a non-PDF payload disguised as a PDF", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      normalizeDispatchCommand(pdfTurn("data:application/pdf;base64,SGVsbG8=")),
    );
    assert.strictEqual(result._tag, "Failure");
  }).pipe(Effect.provide(TestLayer)),
);
