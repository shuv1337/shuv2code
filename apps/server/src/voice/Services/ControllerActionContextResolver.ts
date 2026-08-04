import { ThreadId, TurnId, VoiceActionId, VoiceRuntimeInstanceId } from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ControllerActionContext } from "../../orchestration/Services/ThreadControlService.ts";

export interface ResolveControllerActionInput {
  readonly controllerThreadId: ThreadId;
  readonly controllerRuntimeInstanceId: VoiceRuntimeInstanceId;
  readonly codexProviderThreadId: string;
  readonly providerTurnId: TurnId;
}

export const ControllerActionContextErrorCode = Schema.Literals([
  "action_not_found",
  "action_closed",
  "controller_mismatch",
  "provider_session_mismatch",
  "provider_turn_mismatch",
  "transport_generation_fenced",
]);
export type ControllerActionContextErrorCode = typeof ControllerActionContextErrorCode.Type;

export class ControllerActionContextError extends Schema.TaggedErrorClass<ControllerActionContextError>()(
  "ControllerActionContextError",
  {
    code: ControllerActionContextErrorCode,
    message: Schema.String,
  },
) {}

export interface ControllerActionContextResolverShape {
  /**
   * Resolve an immutable action from the exact controller provider session and
   * provider turn carried by Codex's trusted MCP request metadata.
   *
   * Implementations must never fall back to a mutable "current action".
   */
  readonly resolve: (
    input: ResolveControllerActionInput,
  ) => Effect.Effect<ControllerActionContext, ControllerActionContextError>;
}

export class ControllerActionContextResolver extends Context.Service<
  ControllerActionContextResolver,
  ControllerActionContextResolverShape
>()("@shuv2code/voice/Services/ControllerActionContextResolver") {}

export function makeControllerActionContext(input: {
  readonly voiceActionId: VoiceActionId;
  readonly controllerThreadId: ThreadId;
  readonly transportSessionId: string;
  readonly controllerCodexProviderThreadId: string;
  readonly controllerProviderTurnId: TurnId;
  readonly controllerRuntimeInstanceId: VoiceRuntimeInstanceId;
  readonly transportGeneration: number;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
}): ControllerActionContext {
  return input;
}
