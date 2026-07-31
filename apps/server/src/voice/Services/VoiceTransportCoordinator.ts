import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceControllerError,
  VoiceControllerIdentity,
  VoiceSessionEvent,
  VoiceSessionFence,
  VoiceSessionStartInput,
  VoiceSessionStartResult,
  VoiceSessionStopInput,
  VoiceSessionStopResult,
  VoiceSubscribeEventsInput,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { VoiceCodexIdentity } from "./VoiceRuntimeGateway.ts";

export interface ControllerRuntimeState extends VoiceCodexIdentity {
  readonly controllerThreadId: ThreadId;
  readonly controllerMcpCredentialId: string;
  readonly modelSelection: ModelSelection;
}

export interface ActiveVoiceSession {
  readonly transportSessionId: string;
  readonly fence: VoiceSessionFence;
  readonly environmentId: EnvironmentId;
  readonly hostProjectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly controller: VoiceControllerIdentity;
  readonly controllerRuntime: ControllerRuntimeState;
  readonly answerSdp: string;
  readonly eventCursor: number;
  readonly history: ReadonlyArray<VoiceSessionEvent>;
}

export interface VoiceTransportCoordinatorShape {
  readonly getSession: (clientSessionId: string) => Effect.Effect<ActiveVoiceSession | undefined>;
  readonly getSessions: () => Effect.Effect<ReadonlyMap<string, ActiveVoiceSession>>;
  readonly findSessionByTransport: (match: {
    readonly transportThreadId: ThreadId;
    readonly runtimeInstanceId: string;
    readonly generation: number;
    readonly realtimeSessionId: string;
  }) => Effect.Effect<ActiveVoiceSession | undefined>;
  readonly findSessionsByControllerRuntime: (match: {
    readonly controllerThreadId: ThreadId;
    readonly controllerRuntimeInstanceId: string;
  }) => Effect.Effect<ReadonlyArray<ActiveVoiceSession>>;
  readonly emit: (
    sessionId: string,
    payload: VoiceSessionEvent["payload"],
  ) => Effect.Effect<VoiceSessionEvent | undefined>;
  readonly stopSession: (session: ActiveVoiceSession) => Effect.Effect<void>;
  readonly stopAll: () => Effect.Effect<void>;
  readonly stopForController: (controllerThreadId: ThreadId) => Effect.Effect<void>;
  readonly cleanupStaleStartupLease: (controllerThreadId: ThreadId) => Effect.Effect<void>;
  readonly startTransport: (input: {
    readonly start: VoiceSessionStartInput;
    readonly binding: {
      readonly controllerThreadId: ThreadId;
      readonly hostProjectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly bindingGeneration: number;
      readonly controlEpoch: number;
      readonly state: VoiceControllerIdentity["state"];
      readonly authorizedRuntimeCeiling: VoiceControllerIdentity["authorizedRuntimeCeiling"];
    };
    readonly controllerRuntime: ControllerRuntimeState;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly onActivated: (session: ActiveVoiceSession) => Effect.Effect<void>;
  }) => Effect.Effect<VoiceSessionStartResult, VoiceControllerError>;
  readonly stop: (
    input: VoiceSessionStopInput,
  ) => Effect.Effect<VoiceSessionStopResult, VoiceControllerError>;
  readonly subscribe: (
    input: VoiceSubscribeEventsInput,
  ) => Stream.Stream<VoiceSessionEvent, VoiceControllerError>;
  readonly putControllerRuntime: (
    controllerThreadId: ThreadId,
    runtime: ControllerRuntimeState,
  ) => Effect.Effect<void>;
  readonly getControllerRuntime: (
    controllerThreadId: ThreadId,
  ) => Effect.Effect<ControllerRuntimeState | undefined>;
  readonly deleteControllerRuntime: (controllerThreadId: ThreadId) => Effect.Effect<void>;
  readonly fenceMatches: (session: ActiveVoiceSession, fence: VoiceSessionFence) => boolean;
}

export class VoiceTransportCoordinator extends Context.Service<
  VoiceTransportCoordinator,
  VoiceTransportCoordinatorShape
>()("shuv2code/voice/Services/VoiceTransportCoordinator") {}
