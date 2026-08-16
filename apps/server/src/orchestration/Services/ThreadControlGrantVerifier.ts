import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ControllerActionContext,
  ThreadControlAuthorization,
  ThreadControlError,
} from "./ThreadControlService.ts";

export type ThreadControlGrantOperation = "read" | "control";

/**
 * Revalidates a resolved thread-control grant at the application boundary.
 * Invocation adapters may issue grants from provider credentials, durable
 * thread capabilities, or other trusted transports.
 */
export interface ThreadControlGrantVerifierShape {
  readonly authorize: (
    authorization: ThreadControlAuthorization,
    operation: ThreadControlGrantOperation,
  ) => Effect.Effect<void, ThreadControlError>;
  readonly validateMutation: (
    authorization: ThreadControlAuthorization,
    action: ControllerActionContext,
  ) => Effect.Effect<void, ThreadControlError>;
}

export class ThreadControlGrantVerifier extends Context.Service<
  ThreadControlGrantVerifier,
  ThreadControlGrantVerifierShape
>()("shuv2code/orchestration/Services/ThreadControlGrantVerifier") {}
