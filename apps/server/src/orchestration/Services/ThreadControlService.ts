import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  VoiceActionId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import { TurnId } from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ThreadControlGrant } from "./ThreadControlInvocationResolver.ts";

export interface ThreadControlAuthorization {
  readonly environmentId: EnvironmentId;
  readonly controllerThreadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly authorizedRuntimeCeiling: RuntimeMode;
  readonly liveControllerRuntimeMode: RuntimeMode;
  readonly bindingGeneration: number;
  readonly controlEpoch: number;
  readonly canRead: boolean;
  readonly canControl: boolean;
}

interface ThreadControlActionContextBase {
  readonly actionId: string;
  readonly operationIdPrefix: string;
  readonly createdThreadId: ThreadId;
  readonly providerCreationId: string;
  readonly actorProvenance: Readonly<Record<string, unknown>>;
  readonly controllerThreadId: ThreadId;
}

export interface VoiceControllerActionContext extends ThreadControlActionContextBase {
  readonly adapterKind: "voice-controller";
  readonly voiceActionId: VoiceActionId;
  readonly transportSessionId: string;
  readonly controllerCodexProviderThreadId: string;
  readonly controllerProviderTurnId: TurnId;
  readonly controllerRuntimeInstanceId: VoiceRuntimeInstanceId;
  readonly transportGeneration: number;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
}

export interface DurableThreadActionContext extends ThreadControlActionContextBase {
  readonly adapterKind: "durable-thread";
  readonly credentialId: string;
  readonly providerSessionId: string;
  readonly providerTurnId: string;
  readonly providerRequestId: string;
}

export type ControllerActionContext = VoiceControllerActionContext | DurableThreadActionContext;

export type ThreadControlPhase =
  | "waiting_for_approval"
  | "waiting_for_input"
  | "failed"
  | "starting"
  | "working"
  | "interrupted"
  | "completed"
  | "ready"
  | "stopped";

export interface ThreadControlProjectSummary {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly repositoryIdentity?: string | undefined;
  readonly defaultModelSelection: ModelSelection | null;
}

export interface ThreadControlThreadSummary {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly phase: ThreadControlPhase;
  readonly activeTurnId: TurnId | null;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly latestTurnUpdatedAt: string | null;
}

export interface ThreadControlListInput {
  readonly grant: ThreadControlGrant;
  readonly projectQuery?: string | undefined;
  readonly phase?: ThreadControlPhase | undefined;
  readonly cursor?: number | undefined;
}

export interface ThreadControlListResult {
  readonly snapshotSequence: number;
  readonly projects: ReadonlyArray<ThreadControlProjectSummary>;
  readonly threads: ReadonlyArray<ThreadControlThreadSummary>;
  readonly nextCursor: number | null;
}

export interface ThreadControlGetInput {
  readonly grant: ThreadControlGrant;
  readonly threadId: ThreadId;
  readonly includeUntrustedExcerpt?: boolean | undefined;
  readonly includeUntrustedContext?: boolean | undefined;
}

export interface ThreadControlGetResult {
  readonly snapshotSequence: number;
  readonly snapshotTimestamp: string;
  readonly thread: ThreadControlThreadSummary;
  readonly latestTurnState: string | null;
  readonly lastErrorCode: string | null;
  readonly resultCount: number;
  readonly activityCount: number;
  readonly untrustedTargetContent?: {
    readonly marker: "untrusted-target-content";
    readonly text: string;
  };
  readonly untrustedTargetContext?: {
    readonly marker: "untrusted-target-context";
    readonly messages: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly text: string;
    }>;
  };
}

export interface ThreadControlCreateInput {
  readonly grant: ThreadControlGrant;
  readonly action: ControllerActionContext;
  readonly projectId: ProjectId;
  readonly initialInstruction: string;
  readonly title?: string | undefined;
  readonly model?: string | undefined;
}

export type ThreadControlSendInput =
  | {
      readonly grant: ThreadControlGrant;
      readonly action: ControllerActionContext;
      readonly threadId: ThreadId;
      readonly text: string;
      readonly disposition: "start";
      readonly expectedTurnId: null;
    }
  | {
      readonly grant: ThreadControlGrant;
      readonly action: ControllerActionContext;
      readonly threadId: ThreadId;
      readonly text: string;
      readonly disposition: "steer";
      readonly expectedTurnId: TurnId;
    };

export interface ThreadControlInterruptInput {
  readonly grant: ThreadControlGrant;
  readonly action: ControllerActionContext;
  readonly threadId: ThreadId;
  readonly expectedTurnId: TurnId;
}

export interface ThreadControlMutationResult {
  readonly actionId: string;
  readonly operationId: string;
  readonly targetThreadId: ThreadId;
  readonly disposition: "create" | "start" | "steer" | "interrupt";
  readonly expectedTurnId: TurnId | null;
  readonly acceptedTurnId: TurnId | null;
  readonly acceptedProjectionSequence: number;
  readonly providerConfirmation: "pending" | "confirmed" | "failed" | "indeterminate" | "stale";
}

export const ThreadControlErrorCode = Schema.Literals([
  "read_disabled",
  "control_disabled",
  "environment_mismatch",
  "controller_mismatch",
  "controller_target_forbidden",
  "project_not_found",
  "thread_not_found",
  "thread_not_managed",
  "thread_archived",
  "invalid_model",
  "runtime_ceiling_exceeded",
  "expected_idle",
  "stale_target",
  "already_terminal",
  "invalid_input",
  "dispatch_failed",
]);
export type ThreadControlErrorCode = typeof ThreadControlErrorCode.Type;

export class ThreadControlError extends Schema.TaggedErrorClass<ThreadControlError>()(
  "ThreadControlError",
  {
    code: ThreadControlErrorCode,
    message: Schema.String,
    currentTurnId: Schema.optionalKey(Schema.NullOr(TurnId)),
  },
) {}

export interface ThreadControlServiceShape {
  readonly list: (
    input: ThreadControlListInput,
  ) => Effect.Effect<ThreadControlListResult, ThreadControlError>;
  readonly get: (
    input: ThreadControlGetInput,
  ) => Effect.Effect<ThreadControlGetResult, ThreadControlError>;
  readonly create: (
    input: ThreadControlCreateInput,
  ) => Effect.Effect<ThreadControlMutationResult, ThreadControlError>;
  readonly send: (
    input: ThreadControlSendInput,
  ) => Effect.Effect<ThreadControlMutationResult, ThreadControlError>;
  readonly interrupt: (
    input: ThreadControlInterruptInput,
  ) => Effect.Effect<ThreadControlMutationResult, ThreadControlError>;
}

export class ThreadControlService extends Context.Service<
  ThreadControlService,
  ThreadControlServiceShape
>()("shuv2code/orchestration/Services/ThreadControlService") {}
