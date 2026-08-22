import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@shuv2code/contracts";
import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { describe, expect } from "vite-plus/test";
import { Tool } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadControlGrantRepository } from "../../../persistence/Services/ThreadControlGrants.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { requestThreadControl } from "./handlers.ts";
import { ThreadControlGrantRequestTool } from "./tools.ts";

const threadId = ThreadId.make("thread-opencode");

const invocationLayer = (capabilities: ReadonlySet<McpInvocationContext.McpCapability>) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    credentialId: "credential-opencode",
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerSessionId: "provider-session-opencode",
    providerInstanceId: ProviderInstanceId.make("opencode-shuvcode"),
    profile: { kind: "standard-provider" },
    capabilities,
    issuedAt: 1,
  });

describe("provider-neutral thread-control grant requests", () => {
  effectIt.effect("does not trigger a provider-native approval before the host approval", () =>
    Effect.sync(() => {
      expect(Context.get(ThreadControlGrantRequestTool.annotations, Tool.Readonly)).toBe(true);
      expect(Context.get(ThreadControlGrantRequestTool.annotations, Tool.Destructive)).toBe(false);
      expect(Tool.getJsonSchema(ThreadControlGrantRequestTool)).toEqual({
        type: "object",
        additionalProperties: false,
      });
    }),
  );

  effectIt.effect("lets an OpenCode standard session open the host approval", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<OrchestrationCommand | null>(null);
      const layer = Layer.mergeAll(
        invocationLayer(new Set(["thread-control.request"])),
        Layer.mock(ThreadControlGrantRepository)({
          getByThreadId: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({
                id: threadId,
                projectId: ProjectId.make("project-1"),
                activities: [],
                latestTurn: null,
              } as never),
            ),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) => Ref.set(dispatched, command).pipe(Effect.as({ sequence: 1 })),
        }),
      );

      const result = yield* requestThreadControl({}).pipe(
        Effect.provide(Layer.merge(layer, NodeServices.layer)),
      );
      expect(result).toMatchObject({
        status: "pending_approval",
        activation: "next_turn",
      });
      expect(result.requestId).toMatch(/^thread-control-grant:/);
      expect(yield* Ref.get(dispatched)).toMatchObject({
        type: "thread.activity.append",
        threadId,
        activity: {
          tone: "approval",
          kind: "approval.requested",
          payload: {
            requestId: result.requestId,
            requestKind: "thread-control",
            requestType: "thread_control_grant",
          },
        },
      });
    }),
  );

  effectIt.effect("rejects a standard credential missing the request capability", () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        invocationLayer(new Set(["preview"])),
        Layer.mock(ThreadControlGrantRepository)({
          getByThreadId: () => Effect.die("grant storage must not be called"),
        }),
        Layer.mock(ProjectionSnapshotQuery)({}),
        Layer.mock(OrchestrationEngineService)({}),
      );

      const error = yield* requestThreadControl({}).pipe(
        Effect.provide(Layer.merge(layer, NodeServices.layer)),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unauthorized" });
    }),
  );
});
