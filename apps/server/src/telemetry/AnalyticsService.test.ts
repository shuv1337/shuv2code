import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly shuv2codeVersion?: string;
        readonly t3CodeVersion?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly shuv2codeVersion?: string;
      readonly t3CodeVersion?: string;
    };
  }>;
}

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("does not create an id or send requests without complete explicit opt-in", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const configurations = [
        { name: "default", values: { SHUV2CODE_POSTHOG_HOST: "http://localhost" } },
        {
          name: "enabled-only",
          values: {
            SHUV2CODE_TELEMETRY_ENABLED: true,
            SHUV2CODE_POSTHOG_HOST: "http://localhost",
          },
        },
        {
          name: "key-only",
          values: {
            SHUV2CODE_POSTHOG_KEY: "phc_test_key",
            SHUV2CODE_POSTHOG_HOST: "http://localhost",
          },
        },
      ] as const;

      yield* Effect.forEach(configurations, ({ name, values }) => {
        const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: `shuv2code-telemetry-disabled-${name}-`,
        });
        const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
        const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown(values));
        const batchServerLayer = HttpServer.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            capturedRequests.push({ path: request.url, body: null });
            return HttpServerResponse.jsonUnsafe({});
          }),
        );
        const runtimeLayer = telemetryLayer.pipe(
          Layer.provide(configLayer),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        return Effect.gen(function* () {
          yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
          const config = yield* ServerConfig.ServerConfig;
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.record("test.disabled");
          yield* analytics.flush;

          const fileSystem = yield* FileSystem.FileSystem;
          assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
        }).pipe(Effect.provide(runtimeLayer));
      });

      assert.deepEqual(capturedRequests, []);
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "shuv2code-telemetry-base-",
      });

      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SHUV2CODE_TELEMETRY_ENABLED: true,
          SHUV2CODE_POSTHOG_KEY: "phc_test_key",
          SHUV2CODE_POSTHOG_HOST: "http://localhost",
          SHUV2CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              event.properties?.clientType === "cli-web-client" &&
              event.properties.shuv2codeVersion === packageJson.version &&
              event.properties.t3CodeVersion === undefined,
          ),
        ),
        true,
      );
    }),
  );
});
