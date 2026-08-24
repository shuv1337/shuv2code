import type {
  ModelSelection,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  TurnId,
  VoiceActionId,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type {
  ProviderCreationRecoveryInput,
  ProviderCreationRecoveryResult,
  ProviderThreadSnapshot,
} from "../../provider/Services/ProviderAdapter.ts";

export class VoiceRuntimeGatewayError extends Schema.TaggedErrorClass<VoiceRuntimeGatewayError>()(
  "VoiceRuntimeGatewayError",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

export interface VoiceCodexIdentity {
  readonly codexProviderThreadId: string;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
}

export type VoiceRuntimeGatewayEvent =
  | {
      readonly type: "transport.transcript.delta";
      readonly transportThreadId: ThreadId;
      readonly runtimeInstanceId: VoiceRuntimeInstanceId;
      readonly generation: VoiceGeneration;
      readonly realtimeSessionId: VoiceRealtimeSessionId;
      readonly itemId: string;
      readonly role: "user" | "assistant";
      readonly textDelta: string;
    }
  | {
      readonly type: "transport.transcript.done";
      readonly transportThreadId: ThreadId;
      readonly runtimeInstanceId: VoiceRuntimeInstanceId;
      readonly generation: VoiceGeneration;
      readonly realtimeSessionId: VoiceRealtimeSessionId;
      readonly itemId: string;
      readonly role: "user" | "assistant";
      readonly text: string;
    }
  | {
      readonly type: "transport.item-added";
      readonly transportThreadId: ThreadId;
      readonly runtimeInstanceId: VoiceRuntimeInstanceId;
      readonly generation: VoiceGeneration;
      readonly realtimeSessionId: VoiceRealtimeSessionId;
      readonly item: unknown;
    }
  | {
      readonly type: "transport.closed";
      readonly transportThreadId: ThreadId;
      readonly runtimeInstanceId: VoiceRuntimeInstanceId;
      readonly generation: VoiceGeneration;
      readonly realtimeSessionId: VoiceRealtimeSessionId;
    }
  | {
      readonly type: "transport.error";
      readonly transportThreadId: ThreadId;
      readonly runtimeInstanceId: VoiceRuntimeInstanceId;
      readonly generation: VoiceGeneration;
      readonly realtimeSessionId: VoiceRealtimeSessionId;
      readonly code: string;
    }
  | {
      readonly type: "controller.runtime-lost";
      readonly controllerThreadId: ThreadId;
      readonly runtimeInstanceId: VoiceRuntimeInstanceId;
    };

export interface VoiceRuntimeGatewayShape {
  readonly prepareThreadCall?: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly action: "inspect" | "migrate";
  }) => Effect.Effect<
    | { readonly state: "ready"; readonly historyMode: "paginated" | "not-applicable" }
    | { readonly state: "migration-required"; readonly bytesToProcess: number },
    VoiceRuntimeGatewayError
  >;
  readonly recoverCreatedSession?: (
    input: ProviderCreationRecoveryInput,
  ) => Effect.Effect<ProviderCreationRecoveryResult, VoiceRuntimeGatewayError>;
  /**
   * Provider-authoritative read used only for crash reconciliation. It may
   * recover a resumable provider session, but must never replay a turn.
   */
  readonly readThread?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderThreadSnapshot, VoiceRuntimeGatewayError>;
  readonly resolveModelSelection: (
    providerInstanceId: ProviderInstanceId,
    preferred?: ModelSelection | undefined,
  ) => Effect.Effect<ModelSelection, VoiceRuntimeGatewayError>;
  readonly ensureControllerRuntime: (input: {
    readonly controllerThreadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    /**
     * A newly reserved binding is the only state allowed to create a provider
     * thread. A durable binding resumes its persisted provider cursor when
     * available, then falls back to exact threadSource discovery only for the
     * crash window before that cursor could be persisted.
     */
    readonly creationDisposition: "fresh" | "recover";
    readonly bindingGeneration: number;
    readonly authorizedRuntimeCeiling: RuntimeMode;
    readonly controlEpoch: number;
    readonly controlEnabled: boolean;
  }) => Effect.Effect<
    VoiceCodexIdentity & { readonly controllerMcpCredentialId: string },
    VoiceRuntimeGatewayError
  >;
  readonly stopControllerRuntime: (
    controllerThreadId: ThreadId,
  ) => Effect.Effect<void, VoiceRuntimeGatewayError>;
  readonly startTransport: (input: {
    readonly transportThreadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly runtimeInstanceId: VoiceRuntimeInstanceId;
    readonly generation: VoiceGeneration;
    readonly realtimeSessionId: VoiceRealtimeSessionId;
    readonly realtimeModel: string;
    readonly transportType: "webrtc" | "websocket";
    readonly offerSdp?: string | undefined;
    readonly voiceId?: string | undefined;
    readonly clientManagedHandoffs: true;
    readonly prompt?: string | undefined;
    readonly includeStartupContext?: boolean | undefined;
    readonly initialItems?: ReadonlyArray<{
      readonly role: "user" | "developer" | "assistant";
      readonly text: string;
    }>;
  }) => Effect.Effect<
    VoiceCodexIdentity & {
      readonly answerSdp: string | null;
      readonly transportType: "webrtc" | "websocket";
    },
    VoiceRuntimeGatewayError
  >;
  readonly stopTransport: (input: {
    readonly transportThreadId: ThreadId;
    readonly runtimeInstanceId: VoiceRuntimeInstanceId;
    readonly generation: VoiceGeneration;
    readonly realtimeSessionId?: VoiceRealtimeSessionId | undefined;
  }) => Effect.Effect<void, VoiceRuntimeGatewayError>;
  readonly appendTransportAudio: (input: {
    readonly transportThreadId: ThreadId;
    readonly generation: VoiceGeneration;
    readonly audioBase64: string;
  }) => Effect.Effect<void, VoiceRuntimeGatewayError>;
  readonly listVoices: (controllerThreadId: ThreadId) => Effect.Effect<
    {
      readonly voices: ReadonlyArray<{ readonly id: string; readonly label?: string | undefined }>;
      readonly defaultVoiceId: string | null;
    },
    VoiceRuntimeGatewayError
  >;
  readonly startControllerAction: (input: {
    readonly controllerThreadId: ThreadId;
    readonly controllerRuntimeInstanceId: VoiceRuntimeInstanceId;
    readonly clientUserMessageId: VoiceActionId;
    readonly input: string;
    readonly recoveryPolicy: "forbid";
  }) => Effect.Effect<
    {
      readonly codexProviderThreadId: string;
      readonly turnId: TurnId;
    },
    VoiceRuntimeGatewayError
  >;
  readonly awaitControllerAction: (input: {
    readonly controllerThreadId: ThreadId;
    readonly controllerRuntimeInstanceId: VoiceRuntimeInstanceId;
    readonly turnId: TurnId;
  }) => Effect.Effect<
    {
      readonly status: "completed" | "failed" | "interrupted";
      readonly speakableText: string | null;
    },
    VoiceRuntimeGatewayError
  >;
  readonly appendTransportText: (input: {
    readonly transportThreadId: ThreadId;
    readonly generation: VoiceGeneration;
    readonly text: string;
  }) => Effect.Effect<void, VoiceRuntimeGatewayError>;
  readonly appendTransportSpeech: (input: {
    readonly transportThreadId: ThreadId;
    readonly generation: VoiceGeneration;
    readonly text: string;
  }) => Effect.Effect<void, VoiceRuntimeGatewayError>;
  readonly streamEvents: Stream.Stream<VoiceRuntimeGatewayEvent>;
}

export class VoiceRuntimeGateway extends Context.Service<
  VoiceRuntimeGateway,
  VoiceRuntimeGatewayShape
>()("shuv2code/voice/Services/VoiceRuntimeGateway") {}
