import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);
const decodeSnapshotMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      accessibilityTree: Schema.Unknown,
      consoleEntries: Schema.Array(Schema.Struct({ text: Schema.String })),
      networkEntries: Schema.Array(Schema.Struct({ url: Schema.String })),
      actionTimeline: Schema.Array(Schema.Struct({ id: Schema.String })),
      screenshot: Schema.NullOr(
        Schema.Struct({
          mimeType: Schema.Literal("image/png"),
          width: Schema.Number,
          height: Schema.Number,
        }),
      ),
    }),
  ),
);

const previewSnapshot = (
  overrides: Partial<PreviewAutomationSnapshot> = {},
): PreviewAutomationSnapshot => ({
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: null,
  ...overrides,
});

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it("keeps snapshot results singly encoded and within explicit byte budgets", () => {
  const diagnostics = Array.from({ length: 30 }, (_, index) => ({
    level: "log",
    text: `entry-${index}`,
    timestamp: "2026-07-30T00:00:00.000Z",
  }));
  const requests = Array.from({ length: 30 }, (_, index) => ({
    url: `https://example.test/${index}`,
    method: "GET",
    status: 200,
    failed: false,
    timestamp: "2026-07-30T00:00:00.000Z",
  }));
  const actions = Array.from({ length: 30 }, (_, index) => ({
    id: `action-${index}`,
    action: "click",
    status: "succeeded" as const,
    startedAt: "2026-07-30T00:00:00.000Z",
  }));
  const bounded = McpHttpServer.makePreviewSnapshotCallToolResult(
    previewSnapshot({
      consoleEntries: diagnostics,
      networkEntries: requests,
      actionTimeline: actions,
    }),
  );

  expect(bounded.isError).toBe(false);
  expect(bounded.structuredContent).toBeUndefined();
  expect(bounded.content).toHaveLength(1);
  const text = bounded.content[0];
  expect(text?.type).toBe("text");
  if (text?.type !== "text") throw new Error("Expected text snapshot content.");
  const decoded = decodeSnapshotMetadata(text.text);
  expect(decoded.consoleEntries).toHaveLength(McpHttpServer.MCP_PREVIEW_DIAGNOSTIC_ENTRY_LIMIT);
  expect(decoded.consoleEntries[0]?.text).toBe("entry-10");
  expect(decoded.networkEntries).toHaveLength(McpHttpServer.MCP_PREVIEW_DIAGNOSTIC_ENTRY_LIMIT);
  expect(decoded.networkEntries[0]?.url).toBe("https://example.test/10");
  expect(decoded.actionTimeline).toHaveLength(McpHttpServer.MCP_PREVIEW_DIAGNOSTIC_ENTRY_LIMIT);
  expect(decoded.actionTimeline[0]?.id).toBe("action-10");
  expect(decoded.screenshot).toBeNull();

  const oversizedMetadata = McpHttpServer.makePreviewSnapshotCallToolResult(
    previewSnapshot({
      // Survive compactAccessibilityTree: payload lives on a non-AX field.
      visibleText: "x".repeat(McpHttpServer.MCP_PREVIEW_METADATA_MAX_BYTES),
    }),
  );
  expect(oversizedMetadata.isError).toBe(true);
  expect(JSON.stringify(oversizedMetadata).length).toBeLessThan(1_000);
  expect(oversizedMetadata.structuredContent).toMatchObject({
    error: {
      _tag: McpHttpServer.PREVIEW_SNAPSHOT_BUDGET_ERROR_TAG,
      operation: "snapshot",
      budget: "metadata",
      maximumBytes: McpHttpServer.MCP_PREVIEW_METADATA_MAX_BYTES,
    },
  });

  const oversizedImage = McpHttpServer.makePreviewSnapshotCallToolResult(
    previewSnapshot({
      screenshot: {
        mimeType: "image/png",
        data: Buffer.alloc(McpHttpServer.MCP_PREVIEW_IMAGE_MAX_BYTES + 1).toString("base64"),
        width: 1_280,
        height: 720,
      },
    }),
  );
  expect(oversizedImage.isError).toBe(true);
  expect(oversizedImage.content[0]).toMatchObject({ type: "text" });
  expect(oversizedImage.structuredContent).toMatchObject({
    error: {
      _tag: McpHttpServer.PREVIEW_SNAPSHOT_BUDGET_ERROR_TAG,
      budget: "screenshot",
      maximumBytes: McpHttpServer.MCP_PREVIEW_IMAGE_MAX_BYTES,
    },
  });
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const rawAccessibilityTree = {
        nodes: [
          {
            nodeId: "root",
            role: { value: "RootWebArea" },
            name: { value: "Example" },
          },
          {
            nodeId: "submit",
            parentId: "root",
            role: { value: "button" },
            name: { value: "Submit" },
          },
        ],
      };
      const consoleEntries = Array.from({ length: 25 }, (_, index) => ({
        level: "log",
        text: `console-${index}`,
        timestamp: `console-time-${index}`,
      }));
      const networkEntries = Array.from({ length: 25 }, (_, index) => ({
        url: `https://example.test/${index}`,
        method: "GET",
        status: 200,
        failed: false,
        timestamp: `network-time-${index}`,
      }));
      const actionTimeline = Array.from({ length: 25 }, (_, index) => ({
        id: `action-${index}`,
        action: "click",
        status: "succeeded" as const,
        startedAt: `action-time-${index}`,
      }));
      const routedRequests: Array<{
        readonly operation: string;
        readonly input: unknown;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: rawAccessibilityTree,
                  consoleEntries,
                  networkEntries,
                  actionTimeline,
                  screenshot:
                    typeof event.request.input === "object" &&
                    event.request.input !== null &&
                    "includeScreenshot" in event.request.input &&
                    event.request.input.includeScreenshot === true
                      ? {
                          mimeType: "image/png",
                          data: Buffer.from("png").toString("base64"),
                          width: 10,
                          height: 5,
                        }
                      : null,
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(malformed.isError).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(false);
      expect(snapshot.structuredContent).toBeUndefined();
      const semanticText = snapshot.content.find((content) => content.type === "text");
      expect(semanticText?.type).toBe("text");
      if (semanticText?.type !== "text") throw new Error("Expected text snapshot content.");
      const semanticMetadata = decodeSnapshotMetadata(semanticText.text);
      expect(semanticMetadata.screenshot).toBeNull();
      expect(semanticMetadata.consoleEntries).toHaveLength(20);
      expect(semanticMetadata.consoleEntries[0]?.text).toBe("console-5");
      expect(semanticMetadata.networkEntries).toHaveLength(20);
      expect(semanticMetadata.networkEntries[0]?.url).toBe("https://example.test/5");
      expect(semanticMetadata.actionTimeline).toHaveLength(20);
      expect(semanticMetadata.actionTimeline[0]?.id).toBe("action-5");
      expect(semanticMetadata.accessibilityTree).toMatchObject({
        mode: "compact",
        nodes: expect.arrayContaining([expect.objectContaining({ nodeId: "submit" })]),
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const visualSnapshot = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId, includeScreenshot: true },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(visualSnapshot.isError).toBe(false);
      expect(visualSnapshot.content.some((content) => content.type === "image")).toBe(true);

      const fullSnapshot = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId, mode: "full" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(fullSnapshot.isError).toBe(false);
      const fullText = fullSnapshot.content.find((content) => content.type === "text");
      expect(fullText?.type).toBe("text");
      if (fullText?.type !== "text") throw new Error("Expected text snapshot content.");
      const fullMetadata = decodeSnapshotMetadata(fullText.text);
      expect(fullMetadata.accessibilityTree).toEqual(rawAccessibilityTree);
      expect(fullMetadata.consoleEntries).toHaveLength(20);
      expect(
        routedRequests.find(
          ({ operation, input }) =>
            operation === "snapshot" &&
            typeof input === "object" &&
            input !== null &&
            "mode" in input &&
            input.mode === "full",
        ),
      ).toBeDefined();

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
