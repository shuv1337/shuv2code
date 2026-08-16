import type { ThreadId } from "@shuv2code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import {
  ThreadControlError,
  type ControllerActionContext,
  type ThreadControlAuthorization,
  type ThreadControlMutationResult,
} from "./ThreadControlService.ts";

export interface ThreadControlMutationProvenance {
  readonly toolName: "thread_create" | "thread_send" | "thread_interrupt";
  readonly operation: string;
  readonly canonicalRequestHash: string;
}

export interface ThreadControlMutationExecutionInput<A extends ThreadControlMutationResult> {
  readonly authorization: ThreadControlAuthorization;
  readonly action: ControllerActionContext;
  readonly toolName: ThreadControlMutationProvenance["toolName"];
  readonly operation: string;
  readonly semanticSlot: string;
  readonly targetThreadId: ThreadId;
  readonly canonicalRequest: string;
  readonly providerCreationId: string | null;
  readonly revalidate: Effect.Effect<void, ThreadControlError>;
  readonly dispatch: (
    provenance: ThreadControlMutationProvenance,
  ) => Effect.Effect<A, ThreadControlError>;
}

/**
 * Owns durable, exactly-once execution state for application thread-control
 * mutations. Voice is one adapter; the orchestration service does not know
 * which transport persists the grant lease or active-target hint.
 */
export interface ThreadControlExecutionCoordinatorShape {
  readonly execute: <A extends ThreadControlMutationResult>(
    input: ThreadControlMutationExecutionInput<A>,
  ) => Effect.Effect<A, ThreadControlError>;
  readonly setActiveTarget: (
    authorization: ThreadControlAuthorization,
    targetThreadId: ThreadId,
  ) => Effect.Effect<void>;
  readonly clearActiveTargetIfMatching: (
    authorization: ThreadControlAuthorization,
    targetThreadId: ThreadId,
  ) => Effect.Effect<void>;
}

export class ThreadControlExecutionCoordinator extends Context.Service<
  ThreadControlExecutionCoordinator,
  ThreadControlExecutionCoordinatorShape
>()("shuv2code/orchestration/Services/ThreadControlExecutionCoordinator") {}

export const completeClaimedMutationDispatch = <A>(input: {
  readonly dispatchIntents: Effect.Effect<A, ThreadControlError>;
  readonly markDispatched: () => Effect.Effect<boolean, ThreadControlError>;
  readonly releaseClaim: (mayHavePersistedIntents: boolean) => Effect.Effect<void>;
  readonly reconcileOutcome: () => Effect.Effect<void>;
}): Effect.Effect<A, ThreadControlError> =>
  Effect.gen(function* () {
    const outcome = yield* input.dispatchIntents.pipe(
      Effect.tapError(() => input.releaseClaim(true).pipe(Effect.ignore)),
    );
    const marked = yield* input
      .markDispatched()
      .pipe(Effect.tapError(() => input.releaseClaim(true).pipe(Effect.ignore)));
    if (!marked) {
      yield* input.releaseClaim(true).pipe(Effect.ignore);
      return yield* new ThreadControlError({
        code: "dispatch_failed",
        message: "The thread-control mutation dispatch lease expired.",
      });
    }
    yield* input.reconcileOutcome();
    return outcome;
  });
