import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type RuntimeMode,
  type ThreadId,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadControlGrantRepository } from "../persistence/Services/ThreadControlGrants.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const threadControlGrants = yield* ThreadControlGrantRepository;

    const grantState = (
      threadId: ThreadId,
      grant: Option.Option<{
        readonly authorizedRuntimeCeiling: RuntimeMode;
        readonly controlEnabled: boolean;
        readonly updatedAt: string;
      }>,
    ) =>
      Option.match(grant, {
        onNone: () => ({
          threadId,
          granted: false as const,
          authorizedRuntimeCeiling: null,
          controlEnabled: false,
          updatedAt: null,
        }),
        onSome: (value) => ({
          threadId,
          granted: true as const,
          authorizedRuntimeCeiling: value.authorizedRuntimeCeiling,
          controlEnabled: value.controlEnabled,
          updatedAt: value.updatedAt,
        }),
      });

    const requireOrdinaryThread = Effect.fn("environment.orchestration.requireOrdinaryThread")(
      function* (threadId: ThreadId) {
        const thread = yield* projectionSnapshotQuery
          .getThreadDetailById(threadId)
          .pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
            ),
          );
        if (Option.isNone(thread)) return yield* failEnvironmentNotFound("thread_not_found");
        if ((thread.value.purpose ?? "standard") !== "standard") {
          return yield* failEnvironmentInvalidRequest("invalid_command");
        }
        return thread.value;
      },
    );

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          return yield* orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadControlGrant",
        Effect.fn("environment.orchestration.threadControlGrant")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* requireOrdinaryThread(args.params.threadId);
          const grant = yield* threadControlGrants
            .getByThreadId(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("thread_control_grant_read_failed", cause),
              ),
            );
          return grantState(args.params.threadId, grant);
        }),
      )
      .handle(
        "setThreadControlGrant",
        Effect.fn("environment.orchestration.setThreadControlGrant")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* requireOrdinaryThread(args.params.threadId);
          const existing = yield* threadControlGrants
            .getByThreadId(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("thread_control_grant_read_failed", cause),
              ),
            );
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          yield* threadControlGrants
            .upsert({
              threadId: args.params.threadId,
              authorizedRuntimeCeiling: args.payload.authorizedRuntimeCeiling,
              controlEnabled: args.payload.controlEnabled,
              createdAt: Option.match(existing, {
                onNone: () => updatedAt,
                onSome: (grant) => grant.createdAt,
              }),
              updatedAt,
            })
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("thread_control_grant_write_failed", cause),
              ),
            );
          yield* McpSessionRegistry.revokeActiveMcpThreadProfile(
            args.params.threadId,
            "durable-thread-controller",
          );
          McpProviderSession.clearMcpProviderSessionProfile(
            args.params.threadId,
            "durable-thread-controller",
          );
          return grantState(args.params.threadId, Option.some({ ...args.payload, updatedAt }));
        }),
      )
      .handle(
        "revokeThreadControlGrant",
        Effect.fn("environment.orchestration.revokeThreadControlGrant")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* requireOrdinaryThread(args.params.threadId);
          yield* threadControlGrants
            .revoke(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("thread_control_grant_revoke_failed", cause),
              ),
            );
          yield* McpSessionRegistry.revokeActiveMcpThreadProfile(
            args.params.threadId,
            "durable-thread-controller",
          );
          McpProviderSession.clearMcpProviderSessionProfile(
            args.params.threadId,
            "durable-thread-controller",
          );
          return grantState(args.params.threadId, Option.none());
        }),
      );
  }),
);
