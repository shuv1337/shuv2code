import { CommandId, EventId } from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadControlGrantRepository } from "../../../persistence/Services/ThreadControlGrants.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  isThreadControlGrantApproval,
  makeThreadControlGrantRequestId,
  THREAD_CONTROL_GRANT_REQUEST_ID_PREFIX,
  THREAD_CONTROL_GRANT_REQUEST_KIND,
  THREAD_CONTROL_GRANT_REQUEST_TYPE,
} from "../../ThreadControlGrantRequest.ts";
import { ThreadControlGrantRequestError, ThreadControlGrantRequestToolkit } from "./tools.ts";

const failure = (
  reason: "unauthorized" | "thread_not_found" | "persistence_failed",
  message: string,
) => new ThreadControlGrantRequestError({ reason, message });

export const requestThreadControl = Effect.fn(
  "ThreadControlGrantRequestToolkit.thread_control_request",
)(function* (_input: {}) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("thread-control.request")) {
    return yield* failure(
      "unauthorized",
      "This provider session cannot request thread-control access.",
    );
  }
  const grants = yield* ThreadControlGrantRepository;
  const existingGrant = yield* grants
    .getByThreadId(invocation.threadId)
    .pipe(Effect.mapError((error) => failure("persistence_failed", error.message)));
  if (Option.isSome(existingGrant) && existingGrant.value.controlEnabled) {
    return {
      status: "already_granted" as const,
      requestId: null,
      activation: "next_turn" as const,
      message:
        "Durable thread control is already approved. The shuv2code_controller tools are available now or will attach on the next turn.",
    };
  }

  const snapshots = yield* ProjectionSnapshotQuery;
  const thread = yield* snapshots.getThreadDetailById(invocation.threadId).pipe(
    Effect.mapError((error) => failure("persistence_failed", error.message)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            failure("thread_not_found", "The provider credential's thread no longer exists."),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
  const pending = thread.activities.find((activity) => {
    if (typeof activity.payload !== "object" || activity.payload === null) return false;
    const requestId = (activity.payload as Record<string, unknown>).requestId;
    if (typeof requestId !== "string") return false;
    if (!isThreadControlGrantApproval(activity, requestId)) return false;
    return !thread.activities.some((candidate) => {
      if (
        candidate.kind !== "approval.resolved" ||
        typeof candidate.payload !== "object" ||
        candidate.payload === null
      ) {
        return false;
      }
      return (candidate.payload as Record<string, unknown>).requestId === requestId;
    });
  });
  if (pending && typeof pending.payload === "object" && pending.payload !== null) {
    return {
      status: "already_pending" as const,
      requestId: makeThreadControlGrantRequestId(
        String((pending.payload as Record<string, unknown>).requestId).slice(
          THREAD_CONTROL_GRANT_REQUEST_ID_PREFIX.length,
        ),
      ),
      activation: "next_turn" as const,
      message: "The thread-control request is already waiting for the user's decision.",
    };
  }

  const crypto = yield* Crypto.Crypto;
  const requestId = yield* crypto.randomUUIDv4.pipe(
    Effect.map(makeThreadControlGrantRequestId),
    Effect.orDie,
  );
  const commandId = yield* crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => CommandId.make(`mcp:thread-control-request:${uuid}`)),
    Effect.orDie,
  );
  const activityId = yield* crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => EventId.make(`mcp:thread-control-request:${uuid}`)),
    Effect.orDie,
  );
  const now = DateTime.formatIso(yield* DateTime.now);
  const engine = yield* OrchestrationEngineService;
  yield* engine
    .dispatch(
      {
        type: "thread.activity.append",
        commandId,
        threadId: invocation.threadId,
        activity: {
          id: activityId,
          tone: "approval",
          kind: "approval.requested",
          summary: "Durable thread-control access requested",
          payload: {
            requestId,
            requestKind: THREAD_CONTROL_GRANT_REQUEST_KIND,
            requestType: THREAD_CONTROL_GRANT_REQUEST_TYPE,
            detail:
              "Allow this thread to list, inspect, create, message, steer, and interrupt other shuv2code threads, bounded by this thread's current permission mode.",
          },
          turnId: thread.latestTurn?.turnId ?? null,
          createdAt: now,
        },
        createdAt: now,
      },
      {
        actorProvenance: {
          actorKind: "standard-provider-mcp",
          providerInstanceId: invocation.providerInstanceId,
          credentialId: invocation.credentialId,
        },
      },
    )
    .pipe(Effect.mapError((error) => failure("persistence_failed", error.message)));

  return {
    status: "pending_approval" as const,
    requestId,
    activation: "next_turn" as const,
    message:
      "The user has been asked to approve durable thread control. Do not claim access until approval; shuv2code_controller attaches on the next turn after approval.",
  };
});

export const ThreadControlGrantRequestToolkitHandlersLive =
  ThreadControlGrantRequestToolkit.toLayer({
    thread_control_request: requestThreadControl,
  });
