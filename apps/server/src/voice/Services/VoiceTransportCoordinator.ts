import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceAppendAudioInput,
  VoiceAppendAudioResult,
  VoiceControllerError,
  VoiceControllerIdentity,
  VoiceCallPresence,
  VoiceSessionEvent,
  VoiceSessionFence,
  VoiceSessionStartInput,
  VoiceSessionStartResult,
  VoiceSessionStopInput,
  VoiceSessionStopResult,
  VoiceSubscribeEventsInput,
  VoiceTargetPhase,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProactiveSpeechKind } from "../VoiceProactiveSpeechPolicy.ts";
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
  /** Provider instance that owns realtime media, not delegated durable work. */
  readonly transportProviderInstanceId: ProviderInstanceId;
  readonly transportModelSelection?: ModelSelection;
  readonly controller: VoiceControllerIdentity | null;
  readonly controllerRuntime: ControllerRuntimeState | null;
  readonly call: VoiceCallPresence | null;
  readonly transportType: "webrtc" | "websocket";
  readonly purpose: "conversation" | "transcription";
  readonly answerSdp: string | null;
  readonly lastAudioSequence: number;
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
  readonly cleanupStaleStartupLease: (environmentId: EnvironmentId) => Effect.Effect<void>;
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
    readonly realtimeModel: string;
    readonly onActivated: (session: ActiveVoiceSession) => Effect.Effect<void>;
    /**
     * ADE §4.7 digest-in: the persona projection + bounded recent-messages
     * window this call opens with. Undefined for every ordinary controller
     * session, which keeps that path exactly as it was.
     */
    readonly adeInitialItems?: ReadonlyArray<{
      readonly role: "user" | "developer" | "assistant";
      readonly text: string;
    }>;
  }) => Effect.Effect<VoiceSessionStartResult, VoiceControllerError>;
  readonly startThreadCallTransport: (input: {
    readonly start: VoiceSessionStartInput & {
      readonly owner: { readonly kind: "thread-call"; readonly threadId: ThreadId };
    };
    readonly environmentId: EnvironmentId;
    readonly thread: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly messages: ReadonlyArray<{
        readonly role: "user" | "assistant" | "system";
        readonly text: string;
        readonly streaming: boolean;
        readonly [key: string]: unknown;
      }>;
    };
    readonly transportModelSelection: ModelSelection;
    readonly realtimeModel: string;
    readonly workspaceRoot: string;
    readonly threadSnapshotSequence: number;
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
  /**
   * Always appends bounded tray text. Conditionally queues proactive speech
   * when policy allows. Never maps barge-in or speech failure to target interrupt.
   */
  readonly deliverAssistantUpdate: (input: {
    readonly session: ActiveVoiceSession;
    readonly kind: ProactiveSpeechKind;
    readonly text: string;
    readonly voiceActionId?: string;
    readonly targetThreadId?: ThreadId;
    readonly phase?: VoiceTargetPhase;
  }) => Effect.Effect<void>;
  readonly appendAudio: (
    input: VoiceAppendAudioInput,
  ) => Effect.Effect<VoiceAppendAudioResult, VoiceControllerError>;
}

export class VoiceTransportCoordinator extends Context.Service<
  VoiceTransportCoordinator,
  VoiceTransportCoordinatorShape
>()("shuv2code/voice/Services/VoiceTransportCoordinator") {}
