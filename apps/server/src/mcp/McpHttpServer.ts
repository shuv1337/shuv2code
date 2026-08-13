import type {
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotInput,
} from "@shuv2code/contracts";
import {
  PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT,
  PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES,
  PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
} from "@shuv2code/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { compactAccessibilityTree } from "./CompactAccessibilityTree.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import { AutomationToolkitHandlersLive } from "./toolkits/automations/handlers.ts";
import { AutomationToolkit } from "./toolkits/automations/tools.ts";
import { VoiceToolkitHandlersLive } from "./toolkits/voice/handlers.ts";
import { VoiceToolkit } from "./toolkits/voice/tools.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";

export const MCP_PREVIEW_DIAGNOSTIC_ENTRY_LIMIT =
  PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT;
export const MCP_PREVIEW_METADATA_MAX_BYTES = PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES;
export const MCP_PREVIEW_IMAGE_MAX_BYTES = PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES;

export const PREVIEW_SNAPSHOT_BUDGET_ERROR_TAG = "PreviewSnapshotBudgetExceeded";

const previewSnapshotBudgetError = (
  budget: "metadata" | "screenshot",
  actualBytes: number,
  maximumBytes: number,
  text: string,
): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: PREVIEW_SNAPSHOT_BUDGET_ERROR_TAG,
        operation: "snapshot",
        budget,
        actualBytes,
        maximumBytes,
      },
    },
    content: [{ type: "text", text }],
  });

export const makePreviewSnapshotCallToolResult = (
  snapshot: PreviewAutomationSnapshot,
  mode: PreviewAutomationSnapshotInput["mode"] = "compact",
): McpSchema.CallToolResult => {
  const { screenshot, ...page } = snapshot;
  const metadata = {
    ...page,
    accessibilityTree:
      mode === "full" ? page.accessibilityTree : compactAccessibilityTree(page.accessibilityTree),
    consoleEntries: page.consoleEntries.slice(-MCP_PREVIEW_DIAGNOSTIC_ENTRY_LIMIT),
    networkEntries: page.networkEntries.slice(-MCP_PREVIEW_DIAGNOSTIC_ENTRY_LIMIT),
    actionTimeline: page.actionTimeline.slice(-MCP_PREVIEW_DIAGNOSTIC_ENTRY_LIMIT),
    screenshot:
      screenshot === null
        ? null
        : {
            mimeType: screenshot.mimeType,
            width: screenshot.width,
            height: screenshot.height,
          },
  };
  const encodedMetadata = JSON.stringify(metadata);
  const actualBytes = Buffer.byteLength(encodedMetadata, "utf8");
  if (actualBytes > MCP_PREVIEW_METADATA_MAX_BYTES) {
    // The producer already trims to this same budget, so reaching here means an
    // untrimmable page: only narrower inspection can recover.
    return previewSnapshotBudgetError(
      "metadata",
      actualBytes,
      MCP_PREVIEW_METADATA_MAX_BYTES,
      `Preview snapshot metadata exceeded the ${MCP_PREVIEW_METADATA_MAX_BYTES}-byte safety budget (${actualBytes} bytes). Use preview_evaluate to inspect a specific selector or region instead of the whole page.`,
    );
  }
  const imageBytes = screenshot === null ? 0 : Buffer.byteLength(screenshot.data, "base64");
  if (imageBytes > MCP_PREVIEW_IMAGE_MAX_BYTES) {
    return previewSnapshotBudgetError(
      "screenshot",
      imageBytes,
      MCP_PREVIEW_IMAGE_MAX_BYTES,
      `Preview screenshot exceeded the ${MCP_PREVIEW_IMAGE_MAX_BYTES}-byte safety budget (${imageBytes} bytes). Retry without includeScreenshot or use a smaller viewport.`,
    );
  }

  return new McpSchema.CallToolResult({
    isError: false,
    content: [
      { type: "text", text: encodedMetadata },
      ...(screenshot === null
        ? []
        : [
            {
              type: "image" as const,
              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
              mimeType: screenshot.mimeType,
            },
          ]),
    ],
  });
};

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token, "standard-provider");
        if (!invocation) {
          // Without this the only symptom of a dead credential is the agent
          // quietly losing the whole `shuv2code` toolkit for the rest of its
          // session, with nothing on the server to explain why.
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  if (
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    firstFailure._tag === "PreviewAutomationResultTooLargeError" &&
    "budget" in firstFailure &&
    (firstFailure.budget === "metadata" || firstFailure.budget === "screenshot") &&
    "actualBytes" in firstFailure &&
    typeof firstFailure.actualBytes === "number" &&
    "maximumBytes" in firstFailure &&
    typeof firstFailure.maximumBytes === "number"
  ) {
    const text =
      firstFailure.budget === "screenshot"
        ? `Preview screenshot exceeded the ${firstFailure.maximumBytes}-byte safety budget (${firstFailure.actualBytes} bytes). Retry without includeScreenshot or use a smaller viewport.`
        : `Preview snapshot metadata exceeded the ${firstFailure.maximumBytes}-byte safety budget (${firstFailure.actualBytes} bytes). Use preview_evaluate to inspect a specific selector or region instead of the whole page.`;
    return Effect.succeed(
      previewSnapshotBudgetError(
        firstFailure.budget,
        firstFailure.actualBytes,
        firstFailure.maximumBytes,
        text,
      ),
    );
  }
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as PreviewAutomationSnapshot;
              const mode = (payload as PreviewAutomationSnapshotInput).mode ?? "compact";
              return Effect.succeed(makePreviewSnapshotCallToolResult(snapshot, mode));
            },
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const AutomationToolkitRegistrationLive = McpServer.toolkit(AutomationToolkit).pipe(
  Layer.provide(AutomationToolkitHandlersLive),
);

export const VoiceToolkitRegistrationLive = McpServer.toolkit(VoiceToolkit).pipe(
  Layer.provide(VoiceToolkitHandlersLive),
);

const McpTransportLive = McpServer.layerHttp({
  name: "shuv2code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  AutomationToolkitRegistrationLive,
  VoiceToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
