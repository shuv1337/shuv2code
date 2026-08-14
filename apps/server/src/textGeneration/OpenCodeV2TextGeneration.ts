import * as NodeURL from "node:url";

import { TextGenerationError, type OpenCodeV2Settings } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@shuv2code/shared/git";
import { getModelSelectionStringOptionValue } from "@shuv2code/shared/model";
import { extractJsonObject } from "@shuv2code/shared/schemaJson";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { OpenCodeRuntime, parseOpenCodeModelSlug } from "../provider/opencodeRuntime.ts";
import { createOpenCodeV2Client, type OpenCodeV2Event } from "../provider/opencodeV2Client.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function eventSessionId(event: OpenCodeV2Event): string | undefined {
  const data =
    event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
  return typeof data.sessionID === "string" ? data.sessionID : undefined;
}

export const makeOpenCodeV2TextGeneration = Effect.fn("makeOpenCodeV2TextGeneration")(function* (
  settings: OpenCodeV2Settings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const runtime = yield* OpenCodeRuntime;
  const serverConfig = yield* ServerConfig;

  const runJson = Effect.fn("runOpenCodeV2Json")(function* <S extends Schema.Top>(input: {
    readonly operation: TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: Parameters<
      TextGeneration.TextGeneration["Service"]["generateThreadTitle"]
    >[0]["modelSelection"];
    readonly attachments?: Parameters<
      TextGeneration.TextGeneration["Service"]["generateThreadTitle"]
    >[0]["attachments"];
  }) {
    const model = parseOpenCodeModelSlug(input.modelSelection.model);
    if (!model) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "opencode2 model selection must use the 'provider/model' format.",
      });
    }
    const agent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
    const rawOutput = yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* runtime
          .connectToOpenCodeServer({
            binaryPath: settings.binaryPath,
            requiredProtocol: "v2",
            serverUrl: settings.serverUrl,
            ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
            environment,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: input.operation,
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
        const client = createOpenCodeV2Client({
          baseUrl: server.url,
          directory: input.cwd,
          ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
        });
        const controller = new AbortController();
        return yield* Effect.tryPromise({
          try: async () => {
            const session = await client.session.create({
              model,
              ...(agent ? { agent } : {}),
            });
            try {
              const iterator = client.event
                .subscribe({ signal: controller.signal })
                [Symbol.asyncIterator]();
              const connected = await iterator.next();
              if (connected.done || connected.value.type !== "server.connected") {
                throw new Error("opencode2 event stream did not connect.");
              }
              await client.session.prompt(session.id, {
                text: input.prompt,
                ...(agent ? { agent } : {}),
                ...(input.attachments && input.attachments.length > 0
                  ? {
                      files: input.attachments.flatMap((attachment) => {
                        const path = resolveAttachmentPath({
                          attachmentsDir: serverConfig.attachmentsDir,
                          attachment,
                        });
                        return path
                          ? [{ uri: NodeURL.pathToFileURL(path).href, name: attachment.name }]
                          : [];
                      }),
                    }
                  : {}),
              });
              let output = "";
              while (true) {
                const next = await iterator.next();
                if (next.done) throw new Error("opencode2 event stream ended before completion.");
                const event = next.value;
                if (eventSessionId(event) !== session.id) continue;
                const data =
                  event.data && typeof event.data === "object"
                    ? (event.data as Record<string, unknown>)
                    : {};
                if (event.type === "session.text.delta" && typeof data.delta === "string") {
                  output += data.delta;
                }
                if (event.type === "session.text.ended" && typeof data.text === "string") {
                  output = data.text;
                }
                if (event.type === "session.execution.failed") {
                  throw new Error("opencode2 text-generation session failed.");
                }
                if (event.type === "session.execution.succeeded") return output;
              }
            } finally {
              controller.abort();
            }
          },
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }).pipe(Effect.ensuring(Effect.sync(() => controller.abort())));
      }),
    ).pipe(
      Effect.timeout("3 minutes"),
      Effect.catchTag(
        "TimeoutError",
        () =>
          new TextGenerationError({
            operation: input.operation,
            detail: "opencode2 text generation timed out.",
          }),
      ),
    );
    return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
      extractJsonObject(rawOutput),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "opencode2 returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  return {
    generateCommitMessage: Effect.fn("OpenCodeV2TextGeneration.generateCommitMessage")(
      function* (input) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const generated = yield* runJson({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      },
    ),
    generatePrContent: Effect.fn("OpenCodeV2TextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    }),
    generateBranchName: Effect.fn("OpenCodeV2TextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    }),
    generateThreadTitle: Effect.fn("OpenCodeV2TextGeneration.generateThreadTitle")(
      function* (input) {
        const { prompt, outputSchema } = buildThreadTitlePrompt(input);
        const generated = yield* runJson({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
          attachments: input.attachments,
        });
        return { title: sanitizeThreadTitle(generated.title) };
      },
    ),
  } satisfies TextGeneration.TextGeneration["Service"];
});
