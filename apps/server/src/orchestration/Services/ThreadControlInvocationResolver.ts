import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ControllerActionContext,
  ThreadControlAuthorization,
  ThreadControlError,
} from "./ThreadControlService.ts";
import type { ThreadControlExecutionCoordinatorShape } from "./ThreadControlExecutionCoordinator.ts";
import type { ThreadControlGrantVerifierShape } from "./ThreadControlGrantVerifier.ts";

export type ThreadControlOperation = "read" | "control";

/**
 * An invocation-scoped object capability. It couples immutable authorization
 * data with the adapter that can revalidate and execute it. Canonical thread
 * operations never select a Voice, provider, or automation adapter globally.
 */
export interface ThreadControlGrant {
  readonly authorization: ThreadControlAuthorization;
  readonly verifier: ThreadControlGrantVerifierShape;
  readonly execution: ThreadControlExecutionCoordinatorShape;
}

export interface ThreadControlMutationInvocation {
  readonly grant: ThreadControlGrant;
  readonly action: ControllerActionContext;
}

export const ThreadControlInvocationErrorCode = Schema.Literals([
  "action_not_found",
  "action_closed",
  "controller_mismatch",
  "provider_session_mismatch",
  "provider_turn_mismatch",
  "transport_generation_fenced",
]);
export type ThreadControlInvocationErrorCode = typeof ThreadControlInvocationErrorCode.Type;

export class ThreadControlInvocationError extends Schema.TaggedErrorClass<ThreadControlInvocationError>()(
  "ThreadControlInvocationError",
  {
    code: ThreadControlInvocationErrorCode,
    message: Schema.String,
  },
) {}

/**
 * Resolves the application-owned grant for one provider tool invocation.
 *
 * Provider, credential, and transport adapters implement this boundary. The
 * canonical thread toolkit consumes only the resulting authorization and
 * immutable mutation action.
 */
export interface ThreadControlInvocationResolverShape {
  readonly resolveAuthorization: (
    operation: ThreadControlOperation,
  ) => Effect.Effect<ThreadControlGrant, ThreadControlError>;
  readonly resolveMutation: () => Effect.Effect<
    ThreadControlMutationInvocation,
    ThreadControlError | ThreadControlInvocationError
  >;
}

export class ThreadControlInvocationResolver extends Context.Service<
  ThreadControlInvocationResolver,
  ThreadControlInvocationResolverShape
>()("shuv2code/orchestration/Services/ThreadControlInvocationResolver") {}
