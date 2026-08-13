// @effect-diagnostics nodeBuiltinImport:off

import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";

import { OpenCodeV2Settings, ProviderInstanceId } from "@shuv2code/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../provider/opencodeRuntime.ts";
import { makeOpenCodeV2TextGeneration } from "./OpenCodeV2TextGeneration.ts";

describe("OpenCodeV2TextGeneration", () => {
  it("keeps a locally managed server scoped through SSE completion", async () => {
    let events: NodeHttp.ServerResponse | undefined;
    let connectionClosed = false;
    const server = NodeHttp.createServer(async (request, response) => {
      const path = new URL(request.url ?? "", "http://localhost").pathname;
      if (path === "/api/session" && request.method === "POST") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: { id: "ses_1" } }));
        return;
      }
      if (path === "/api/event" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
        events = response;
        return;
      }
      if (path === "/api/session/ses_1/prompt" && request.method === "POST") {
        for await (const _chunk of request) {
          // Drain the body before completing the prompt request.
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: {} }));
        events?.write(
          `data: ${JSON.stringify({
            type: "session.text.ended",
            data: {
              sessionID: "ses_1",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: '{"title":"Native v2"}',
            },
          })}\n\n`,
        );
        events?.write(
          `data: ${JSON.stringify({
            type: "session.execution.succeeded",
            data: { sessionID: "ses_1" },
          })}\n\n`,
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    NodeAssert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const runtime = {
      connectToOpenCodeServer: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              connectionClosed = true;
            }),
          );
          return {
            url: baseUrl,
            exitCode: Effect.never,
            external: false,
            sharedService: false,
            protocol: "v2" as const,
          };
        }),
    } as unknown as OpenCodeRuntimeShape;
    const settings = Schema.decodeSync(OpenCodeV2Settings)({ binaryPath: "fake-opencode2" });
    const layer = Layer.succeed(OpenCodeRuntime, runtime).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "opencode2-text-test-" })),
      Layer.provideMerge(NodeServices.layer),
    );

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const textGeneration = yield* makeOpenCodeV2TextGeneration(settings);
          return yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("opencodeV2"),
              model: "openai/gpt-5",
            },
          });
        }).pipe(Effect.provide(layer)),
      );
      NodeAssert.deepEqual(result, { title: "Native v2" });
      NodeAssert.equal(connectionClosed, true);
    } finally {
      events?.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
