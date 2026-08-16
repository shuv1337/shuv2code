import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ControllerActionContext,
  ThreadControlAuthorization,
  ThreadControlError,
} from "./ThreadControlService.ts";

export type ThreadControlOperation = "read" | "control";

export interface ThreadControlMutationInvocation {
  readonly authorization: ThreadControlAuthorization;
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
  ) => Effect.Effect<ThreadControlAuthorization, ThreadControlError>;
  readonly resolveMutation: () => Effect.Effect<
    ThreadControlMutationInvocation,
    ThreadControlError | ThreadControlInvocationError
  >;
}

export class ThreadControlInvocationResolver extends Context.Service<
  ThreadControlInvocationResolver,
  ThreadControlInvocationResolverShape
>()("shuv2code/orchestration/Services/ThreadControlInvocationResolver") {}
