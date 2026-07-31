import {
  MessageId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  type TurnId,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import { compareSemverVersions, parseSemver } from "@shuv2code/shared/semver";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { ProviderThreadTurnSnapshot } from "../../provider/Services/ProviderAdapter.ts";
import {
  VoiceRuntimeGateway,
  VoiceRuntimeGatewayError,
  type VoiceRuntimeGatewayEvent,
  type VoiceRuntimeGatewayShape,
} from "../Services/VoiceRuntimeGateway.ts";

const CODEX = ProviderDriverKind.make("codex");
const NEGOTIATION_TIMEOUT = "20 seconds";
const ACTION_TIMEOUT = "30 minutes";
const ACTION_HISTORY_POLL_INTERVAL = "1 second";
const MAX_SPEAKABLE_TEXT = 8_192;
export const MINIMUM_REALTIME_CODEX_VERSION = "0.146.0";

type ControllerOutcome = {
  readonly status: "completed" | "failed" | "interrupted";
  readonly speakableText: string | null;
};

interface ControllerTurnState {
  readonly text: string;
  readonly outcome?: ControllerOutcome;
  readonly waiters: ReadonlyArray<Deferred.Deferred<ControllerOutcome>>;
}

const gatewayError = (code: string, message: string) =>
  new VoiceRuntimeGatewayError({ code, message });

const mapProviderFailure =
  (code: string, message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, VoiceRuntimeGatewayError, R> =>
    effect.pipe(Effect.mapError(() => gatewayError(code, message)));

const turnKey = (threadId: ThreadId, turnId: TurnId): string => `${threadId}\u0000${turnId}`;

const isExactRuntime = (
  session: ProviderSession,
  threadId: ThreadId,
  runtimeInstanceId: VoiceRuntimeInstanceId,
): boolean =>
  session.threadId === threadId &&
  session.runtimeInstanceId === runtimeInstanceId &&
  session.status !== "closed";

function readRealtimeFence(event: ProviderRuntimeEvent):
  | {
      readonly runtimeInstanceId: VoiceRuntimeInstanceId;
      readonly generation: VoiceGeneration;
      readonly realtimeSessionId: VoiceRealtimeSessionId;
    }
  | undefined {
  if (
    event.type !== "thread.realtime.item-added" &&
    event.type !== "thread.realtime.transcript.delta" &&
    event.type !== "thread.realtime.transcript.done" &&
    event.type !== "thread.realtime.sdp" &&
    event.type !== "thread.realtime.error" &&
    event.type !== "thread.realtime.closed"
  ) {
    return undefined;
  }
  const runtimeInstanceId = event.payload.runtimeInstanceId;
  const generation = event.payload.generation;
  const realtimeSessionId = event.payload.realtimeSessionId;
  if (
    typeof runtimeInstanceId !== "string" ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    typeof realtimeSessionId !== "string"
  ) {
    return undefined;
  }
  return {
    runtimeInstanceId: VoiceRuntimeInstanceId.make(runtimeInstanceId),
    generation: VoiceGeneration.make(generation),
    realtimeSessionId: VoiceRealtimeSessionId.make(realtimeSessionId),
  };
}

function mapTransportEvent(event: ProviderRuntimeEvent): VoiceRuntimeGatewayEvent | undefined {
  const fence = readRealtimeFence(event);
  if (!fence) return undefined;
  const base = {
    transportThreadId: event.threadId,
    ...fence,
  };
  switch (event.type) {
    case "thread.realtime.transcript.delta":
      return {
        type: "transport.transcript.delta",
        ...base,
        itemId: event.itemId ?? `transcript:${event.payload.ingressSequence}`,
        role: event.payload.role,
        textDelta: event.payload.delta,
      };
    case "thread.realtime.transcript.done":
      return {
        type: "transport.transcript.done",
        ...base,
        itemId: event.itemId ?? `transcript:${event.payload.ingressSequence}`,
        role: event.payload.role,
        text: event.payload.text,
      };
    case "thread.realtime.item-added":
      return {
        type: "transport.item-added",
        ...base,
        item: event.payload.item,
      };
    case "thread.realtime.error":
      return {
        type: "transport.error",
        ...base,
        code: "realtime_error",
      };
    case "thread.realtime.closed":
      return {
        type: "transport.closed",
        ...base,
      };
    case "thread.realtime.sdp":
      return undefined;
  }
}

function toControllerOutcome(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
  speakableText: string,
): ControllerOutcome {
  if (event.type === "turn.aborted") {
    return {
      status: "interrupted",
      speakableText: speakableText.trim().length > 0 ? speakableText.trim() : null,
    };
  }
  return {
    status:
      event.payload.state === "completed"
        ? "completed"
        : event.payload.state === "interrupted" || event.payload.state === "cancelled"
          ? "interrupted"
          : "failed",
    speakableText: speakableText.trim().length > 0 ? speakableText.trim() : null,
  };
}

function readAssistantText(items: ReadonlyArray<unknown>): string {
  const messages = items.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const candidate = item as {
      readonly type?: unknown;
      readonly text?: unknown;
      readonly phase?: unknown;
    };
    if (candidate.type !== "agentMessage" || typeof candidate.text !== "string") return [];
    return [{ text: candidate.text, phase: candidate.phase }];
  });
  const finalMessages = messages.filter((message) => message.phase === "final_answer");
  return (finalMessages.length > 0 ? finalMessages : messages)
    .map((message) => message.text)
    .join("")
    .slice(-MAX_SPEAKABLE_TEXT);
}

function toPersistedControllerOutcome(
  turn: ProviderThreadTurnSnapshot,
): ControllerOutcome | undefined {
  if (turn.status === undefined || turn.status === "inProgress") return undefined;
  const text = readAssistantText(turn.items).trim();
  return {
    status:
      turn.status === "completed"
        ? "completed"
        : turn.status === "interrupted"
          ? "interrupted"
          : "failed",
    speakableText: text.length > 0 ? text : null,
  };
}

export const makeVoiceRuntimeGateway = Effect.fn("VoiceRuntimeGateway.make")(function* () {
  const provider = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const mcpRegistry = yield* McpSessionRegistry;
  const crypto = yield* Crypto.Crypto;
  const gatewayEvents = yield* PubSub.unbounded<VoiceRuntimeGatewayEvent>();
  const rawEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const controllerRuntimeIds = yield* Ref.make(new Map<ThreadId, VoiceRuntimeInstanceId>());
  const controllerRuntimeModels = yield* Ref.make(new Map<ThreadId, string>());
  const controllerTurns = yield* Ref.make(new Map<string, ControllerTurnState>());

  const awaitPersistedControllerOutcome = Effect.fn(
    "VoiceRuntimeGateway.awaitPersistedControllerOutcome",
  )(function* (threadId: ThreadId, turnId: TurnId) {
    let terminalCandidate: ControllerOutcome | undefined;
    while (true) {
      const snapshot =
        provider.readThread === undefined
          ? Option.none()
          : yield* provider.readThread(threadId).pipe(
              Effect.map((value) => Option.some(value)),
              Effect.orElseSucceed(() => Option.none()),
            );
      if (Option.isSome(snapshot)) {
        const turn = snapshot.value.turns.find((candidate) => candidate.id === turnId);
        if (turn !== undefined) {
          const outcome = toPersistedControllerOutcome(turn);
          if (outcome !== undefined) {
            if (outcome.status !== "interrupted") return outcome;
            if (terminalCandidate?.status === outcome.status) return outcome;
            terminalCandidate = outcome;
          } else {
            terminalCandidate = undefined;
          }
        } else {
          terminalCandidate = undefined;
        }
      } else {
        terminalCandidate = undefined;
      }
      yield* Effect.sleep(ACTION_HISTORY_POLL_INTERVAL);
    }
  });

  const readValidControllerCredential = Effect.fn(
    "VoiceRuntimeGateway.readValidControllerCredential",
  )(function* (
    input: Parameters<VoiceRuntimeGatewayShape["ensureControllerRuntime"]>[0],
    session: ProviderSession,
  ) {
    const reject = (reason: string) =>
      Effect.logWarning("voice controller runtime reuse rejected", {
        reason,
        controllerThreadId: input.controllerThreadId,
      }).pipe(Effect.as(undefined));
    const config = McpProviderSession.readMcpProviderSessions(input.controllerThreadId).find(
      (entry) => entry.profile.kind === "voice-controller",
    );
    if (config === undefined) {
      return yield* reject("credential_config_missing");
    }
    if (config.providerInstanceId !== input.providerInstanceId) {
      return yield* reject("provider_instance_mismatch");
    }
    const token = config.authorizationHeader.replace(/^Bearer\s+/, "");
    const scope = yield* mcpRegistry.resolve(token, "voice-controller");
    if (scope === undefined) {
      return yield* reject("credential_scope_missing");
    }
    const checks = [
      ["credential_id_mismatch", scope.credentialId === config.credentialId],
      ["thread_id_mismatch", scope.threadId === input.controllerThreadId],
      ["scope_provider_instance_mismatch", scope.providerInstanceId === input.providerInstanceId],
      ["profile_kind_mismatch", scope.profile.kind === "voice-controller"],
      [
        "profile_controller_thread_mismatch",
        scope.profile.kind === "voice-controller" &&
          scope.profile.controllerThreadId === input.controllerThreadId,
      ],
      [
        "runtime_instance_mismatch",
        scope.profile.kind === "voice-controller" &&
          scope.profile.runtimeInstanceId === session.runtimeInstanceId,
      ],
      [
        "authorized_ceiling_mismatch",
        scope.profile.kind === "voice-controller" &&
          scope.profile.authorizedRuntimeCeiling === input.authorizedRuntimeCeiling,
      ],
      [
        "live_runtime_mode_mismatch",
        scope.profile.kind === "voice-controller" &&
          scope.profile.liveControllerRuntimeMode === input.runtimeMode,
      ],
      [
        "control_epoch_mismatch",
        scope.profile.kind === "voice-controller" &&
          scope.profile.controlEpoch === input.controlEpoch,
      ],
      ["read_capability_missing", scope.capabilities.has("threads.read")],
      [
        "control_capability_mismatch",
        scope.capabilities.has("threads.control") === input.controlEnabled,
      ],
    ] as const;
    const failed = checks.find(([, valid]) => !valid);
    if (failed !== undefined) {
      return yield* reject(failed[0]);
    }
    return config;
  });

  const settleControllerTurn = Effect.fn("VoiceRuntimeGateway.settleControllerTurn")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
  ) {
    if (event.turnId === undefined) return;
    const key = turnKey(event.threadId, event.turnId);
    const settled = yield* Ref.modify(controllerTurns, (states) => {
      const current = states.get(key) ?? { text: "", waiters: [] };
      const outcome = toControllerOutcome(event, current.text);
      const next = new Map(states);
      next.set(key, { ...current, outcome, waiters: [] });
      return [{ waiters: current.waiters, outcome }, next] as const;
    });
    yield* Effect.forEach(settled.waiters, (waiter) => Deferred.succeed(waiter, settled.outcome));
  });

  yield* provider.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        yield* PubSub.publish(rawEvents, event);
        const mapped = mapTransportEvent(event);
        if (mapped !== undefined) {
          yield* PubSub.publish(gatewayEvents, mapped);
        }
        if (
          event.type === "content.delta" &&
          event.turnId !== undefined &&
          event.payload.streamKind === "assistant_text"
        ) {
          const key = turnKey(event.threadId, event.turnId);
          yield* Ref.update(controllerTurns, (states) => {
            const current = states.get(key) ?? { text: "", waiters: [] };
            const next = new Map(states);
            next.set(key, {
              ...current,
              text: `${current.text}${event.payload.delta}`.slice(-MAX_SPEAKABLE_TEXT),
            });
            return next;
          });
        } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
          yield* settleControllerTurn(event);
        } else if (event.type === "session.exited" || event.type === "runtime.error") {
          const currentRuntimeInstanceId = (yield* Ref.get(controllerRuntimeIds)).get(
            event.threadId,
          );
          const originatingRuntimeInstanceId =
            event.payload.runtimeInstanceId === undefined
              ? undefined
              : VoiceRuntimeInstanceId.make(event.payload.runtimeInstanceId);
          if (
            currentRuntimeInstanceId !== undefined &&
            originatingRuntimeInstanceId === currentRuntimeInstanceId
          ) {
            yield* PubSub.publish(gatewayEvents, {
              type: "controller.runtime-lost",
              controllerThreadId: event.threadId,
              runtimeInstanceId: originatingRuntimeInstanceId,
            });
          }
        }
      }),
    ),
    Effect.forkScoped,
  );

  const resolveModelSelection: VoiceRuntimeGatewayShape["resolveModelSelection"] = Effect.fn(
    "VoiceRuntimeGateway.resolveModelSelection",
  )(function* (providerInstanceId, preferred) {
    const info = yield* provider
      .getInstanceInfo(providerInstanceId)
      .pipe(mapProviderFailure("provider_unavailable", "The provider instance is unavailable."));
    if (!info.enabled || info.driverKind !== CODEX) {
      return yield* gatewayError(
        "realtime_unavailable",
        "Realtime voice requires an enabled Codex provider instance.",
      );
    }
    const snapshot = (yield* providerRegistry.getProviders).find(
      (candidate) => candidate.instanceId === providerInstanceId,
    );
    if (
      snapshot === undefined ||
      snapshot.driver !== CODEX ||
      !snapshot.enabled ||
      snapshot.availability === "unavailable"
    ) {
      return yield* gatewayError(
        "realtime_unavailable",
        "The enabled Codex provider snapshot is unavailable.",
      );
    }
    if (
      snapshot.version === null ||
      parseSemver(snapshot.version) === null ||
      compareSemverVersions(snapshot.version, MINIMUM_REALTIME_CODEX_VERSION) < 0
    ) {
      return yield* gatewayError(
        "incompatible_version",
        `Realtime voice requires Codex ${MINIMUM_REALTIME_CODEX_VERSION} or newer.`,
      );
    }
    if (preferred !== undefined) {
      if (
        preferred.instanceId !== providerInstanceId ||
        !snapshot.models.some((model) => model.slug === preferred.model)
      ) {
        return yield* gatewayError(
          "model_unavailable",
          "The selected Codex model is not advertised by this provider instance.",
        );
      }
      return preferred;
    }
    const defaults = snapshot.models.filter((model) => model.isDefault === true);
    if (defaults.length !== 1) {
      return yield* gatewayError(
        defaults.length === 0 ? "default_model_missing" : "default_model_ambiguous",
        defaults.length === 0
          ? "The Codex provider does not advertise a default model."
          : "The Codex provider advertises more than one default model.",
      );
    }
    return {
      instanceId: providerInstanceId,
      model: defaults[0]!.slug,
    };
  });

  const ensureControllerRuntime: VoiceRuntimeGatewayShape["ensureControllerRuntime"] = Effect.fn(
    "VoiceRuntimeGateway.ensureControllerRuntime",
  )(function* (input) {
    const active = (yield* provider.listSessions()).find(
      (session) => session.threadId === input.controllerThreadId && session.status !== "closed",
    );
    const requestedRuntimeModel = (yield* Ref.get(controllerRuntimeModels)).get(
      input.controllerThreadId,
    );
    const exactRequestedModel =
      active?.providerInstanceId === input.providerInstanceId &&
      requestedRuntimeModel === input.modelSelection.model;
    if (active !== undefined && !exactRequestedModel) {
      yield* Effect.logWarning("voice controller runtime reuse rejected", {
        reason:
          active.providerInstanceId !== input.providerInstanceId
            ? "active_provider_instance_mismatch"
            : "requested_model_mismatch",
        controllerThreadId: input.controllerThreadId,
      });
    }
    if (
      exactRequestedModel &&
      active?.runtimeInstanceId !== undefined &&
      active.providerThreadId !== undefined
    ) {
      const existingCredential = yield* readValidControllerCredential(input, active);
      if (existingCredential !== undefined) {
        const runtimeInstanceId = VoiceRuntimeInstanceId.make(active.runtimeInstanceId);
        yield* Ref.update(controllerRuntimeIds, (current) => {
          const next = new Map(current);
          next.set(input.controllerThreadId, runtimeInstanceId);
          return next;
        });
        yield* Ref.update(controllerRuntimeModels, (current) => {
          const next = new Map(current);
          next.set(input.controllerThreadId, input.modelSelection.model);
          return next;
        });
        return {
          codexProviderThreadId: active.providerThreadId,
          runtimeInstanceId,
          controllerMcpCredentialId: existingCredential.credentialId,
        };
      }
    }
    if (active !== undefined) {
      yield* provider
        .stopSession({ threadId: input.controllerThreadId })
        .pipe(
          mapProviderFailure(
            "controller_rotation_failed",
            "The stale controller runtime could not be rotated.",
          ),
        );
    }

    const runtimeInstanceId = VoiceRuntimeInstanceId.make(
      yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() =>
          gatewayError(
            "identity_generation_failed",
            "The controller identity could not be generated.",
          ),
        ),
      ),
    );
    // Include the durable shell id as well as its generation. Generations are
    // allocated per environment, so generation alone is not globally unique
    // when environments share the same Codex home and workspace.
    const controllerThreadSource = `shuv2code/voice-controller/${input.controllerThreadId}/v${input.bindingGeneration}`;
    const controllerStartInput = {
      threadId: input.controllerThreadId,
      providerInstanceId: input.providerInstanceId,
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      threadPurpose: "voice-controller" as const,
      runtimeInstanceId,
      controllerGrant: {
        controllerThreadId: input.controllerThreadId,
        runtimeInstanceId,
        authorizedRuntimeCeiling: input.authorizedRuntimeCeiling,
        liveControllerRuntimeMode: input.runtimeMode,
        controlEpoch: input.controlEpoch,
        controlEnabled: input.controlEnabled,
      },
    };
    const session =
      input.creationDisposition === "fresh"
        ? yield* provider
            .startSession(input.controllerThreadId, {
              ...controllerStartInput,
              recoveryPolicy: "forbid",
              threadSource: controllerThreadSource,
            })
            .pipe(
              mapProviderFailure(
                "controller_start_failed",
                "The Codex controller runtime could not be started.",
              ),
            )
        : yield* Effect.gen(function* () {
            if (provider.recoverCreatedSession === undefined) {
              return yield* gatewayError(
                "controller_creation_recovery_unavailable",
                "The controller provider does not support exact creation recovery.",
              );
            }
            const recovered = yield* provider
              .recoverCreatedSession({
                ...controllerStartInput,
                threadSource: controllerThreadSource,
              })
              .pipe(
                mapProviderFailure(
                  "controller_creation_recovery_failed",
                  "The Codex controller runtime could not be recovered exactly.",
                ),
              );
            if (recovered.state === "not_found") {
              return yield* gatewayError(
                "controller_creation_not_found",
                "No provider thread matched the durable controller identity.",
              );
            }
            if (recovered.state === "ambiguous") {
              return yield* gatewayError(
                "controller_creation_ambiguous",
                "More than one provider thread matched the durable controller identity.",
              );
            }
            return recovered.session;
          });
    if (session.runtimeInstanceId !== runtimeInstanceId || session.providerThreadId === undefined) {
      yield* provider.stopSession({ threadId: input.controllerThreadId }).pipe(Effect.ignore);
      return yield* gatewayError(
        "identity_mismatch",
        "The Codex controller returned an unexpected runtime identity.",
      );
    }
    const controllerCredential = yield* readValidControllerCredential(input, session);
    if (controllerCredential === undefined) {
      yield* provider.stopSession({ threadId: input.controllerThreadId }).pipe(Effect.ignore);
      return yield* gatewayError(
        "controller_credential_invalid",
        "The live controller credential did not match the current binding grant.",
      );
    }
    yield* Ref.update(controllerRuntimeIds, (current) => {
      const next = new Map(current);
      next.set(input.controllerThreadId, runtimeInstanceId);
      return next;
    });
    yield* Ref.update(controllerRuntimeModels, (current) => {
      const next = new Map(current);
      next.set(input.controllerThreadId, input.modelSelection.model);
      return next;
    });
    return {
      codexProviderThreadId: session.providerThreadId,
      runtimeInstanceId,
      controllerMcpCredentialId: controllerCredential.credentialId,
    };
  });

  const startTransport: VoiceRuntimeGatewayShape["startTransport"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(rawEvents);
        const session = yield* provider
          .startSession(input.transportThreadId, {
            threadId: input.transportThreadId,
            providerInstanceId: input.providerInstanceId,
            cwd: input.cwd,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            recoveryPolicy: "forbid",
            threadPurpose: "voice-transport",
            threadSource: "shuv2code_voice_transport_v1",
            runtimeInstanceId: input.runtimeInstanceId,
            enableRealtimeConversation: true,
          })
          .pipe(
            mapProviderFailure(
              "transport_start_failed",
              "The Codex voice transport could not be started.",
            ),
          );
        if (
          session.runtimeInstanceId !== input.runtimeInstanceId ||
          session.providerThreadId === undefined
        ) {
          yield* provider.stopSession({ threadId: input.transportThreadId }).pipe(Effect.ignore);
          return yield* gatewayError(
            "identity_mismatch",
            "The Codex transport returned an unexpected runtime identity.",
          );
        }
        yield* provider
          .startRealtime({
            threadId: input.transportThreadId,
            generation: input.generation,
            realtimeSessionId: input.realtimeSessionId,
            offerSdp: input.offerSdp,
            ...(input.voiceId !== undefined ? { voiceId: input.voiceId } : {}),
            clientManagedHandoffs: true,
          })
          .pipe(
            mapProviderFailure(
              "realtime_start_failed",
              "The realtime WebRTC negotiation could not be started.",
            ),
          );
        const negotiation = yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (event) =>
              (event.type === "thread.realtime.sdp" ||
                event.type === "thread.realtime.error" ||
                event.type === "thread.realtime.closed") &&
              event.threadId === input.transportThreadId &&
              event.payload.runtimeInstanceId === input.runtimeInstanceId &&
              event.payload.generation === input.generation &&
              event.payload.realtimeSessionId === input.realtimeSessionId,
          ),
          Stream.runHead,
          Effect.timeoutOption(NEGOTIATION_TIMEOUT),
        );
        if (Option.isNone(negotiation) || Option.isNone(negotiation.value)) {
          yield* provider.stopSession({ threadId: input.transportThreadId }).pipe(Effect.ignore);
          return yield* gatewayError(
            "negotiation_timeout",
            "No matching realtime SDP answer arrived before the negotiation deadline.",
          );
        }
        const answerEvent = negotiation.value.value;
        if (answerEvent.type === "thread.realtime.error") {
          return yield* gatewayError(
            "realtime_start_rejected",
            "Codex rejected the realtime WebRTC session during negotiation.",
          );
        }
        if (answerEvent.type === "thread.realtime.closed") {
          return yield* gatewayError(
            "realtime_closed_during_negotiation",
            "The realtime WebRTC session closed during negotiation.",
          );
        }
        if (answerEvent.type !== "thread.realtime.sdp") {
          return yield* gatewayError(
            "protocol_violation",
            "The realtime SDP response was malformed.",
          );
        }
        return {
          codexProviderThreadId: session.providerThreadId,
          runtimeInstanceId: input.runtimeInstanceId,
          answerSdp: answerEvent.payload.sdp,
        };
      }).pipe(
        // Once provider startup has been attempted, every negotiation failure
        // tears down the transport session. The durable controller layer will
        // independently fence its lease and archive the transport thread.
        Effect.onError(() =>
          provider.stopSession({ threadId: input.transportThreadId }).pipe(Effect.ignore),
        ),
        Effect.withSpan("VoiceRuntimeGateway.startTransport"),
      ),
    );

  return VoiceRuntimeGateway.of({
    ...(provider.recoverCreatedSession === undefined
      ? {}
      : {
          recoverCreatedSession: (input) =>
            provider.recoverCreatedSession!(input).pipe(
              mapProviderFailure(
                "creation_recovery_failed",
                "The provider creation could not be recovered exactly.",
              ),
            ),
        }),
    ...(provider.readThread === undefined
      ? {}
      : {
          readThread: (threadId: ThreadId) =>
            provider.readThread!(threadId).pipe(
              mapProviderFailure(
                "thread_reconciliation_read_failed",
                "The provider thread could not be read for crash reconciliation.",
              ),
            ),
        }),
    resolveModelSelection,
    ensureControllerRuntime,
    stopControllerRuntime: (controllerThreadId) =>
      provider.stopSession({ threadId: controllerThreadId }).pipe(
        Effect.tap(() =>
          Effect.all([
            Ref.update(controllerRuntimeIds, (current) => {
              const next = new Map(current);
              next.delete(controllerThreadId);
              return next;
            }),
            Ref.update(controllerRuntimeModels, (current) => {
              const next = new Map(current);
              next.delete(controllerThreadId);
              return next;
            }),
          ]),
        ),
        mapProviderFailure(
          "controller_stop_failed",
          "The Codex controller runtime could not be stopped.",
        ),
      ),
    startTransport,
    stopTransport: (input) =>
      Effect.gen(function* () {
        const session = (yield* provider.listSessions()).find((candidate) =>
          isExactRuntime(candidate, input.transportThreadId, input.runtimeInstanceId),
        );
        if (session === undefined) {
          return yield* gatewayError(
            "stale_transport",
            "The exact voice transport runtime is no longer active.",
          );
        }
        yield* provider
          .stopRealtime({
            threadId: input.transportThreadId,
            generation: input.generation,
          })
          .pipe(
            Effect.ensuring(
              provider.stopSession({ threadId: input.transportThreadId }).pipe(Effect.ignore),
            ),
            mapProviderFailure(
              "transport_stop_failed",
              "The Codex voice transport could not be stopped.",
            ),
          );
      }),
    listVoices: (controllerThreadId) =>
      provider.listRealtimeVoices(controllerThreadId).pipe(
        mapProviderFailure(
          "voice_catalog_unavailable",
          "The Codex v3 realtime voice catalog is unavailable.",
        ),
        Effect.flatMap((catalog) =>
          catalog.unsupportedReason !== undefined
            ? Effect.fail(
                gatewayError(
                  catalog.unsupportedReason,
                  `Codex realtime voice is unavailable: ${catalog.unsupportedReason}.`,
                ),
              )
            : catalog.voices.length > 0
              ? Effect.succeed(catalog)
              : Effect.fail(
                  gatewayError(
                    "empty_voice_catalog",
                    "Codex realtime is enabled but returned no v3-compatible voices.",
                  ),
                ),
        ),
      ),
    startControllerAction: (input) =>
      Effect.gen(function* () {
        if (input.recoveryPolicy !== "forbid") {
          return yield* gatewayError(
            "recovery_forbidden",
            "Controller action turns cannot use provider recovery.",
          );
        }
        const session = (yield* provider.listSessions()).find((candidate) =>
          isExactRuntime(candidate, input.controllerThreadId, input.controllerRuntimeInstanceId),
        );
        if (session?.providerThreadId === undefined) {
          return yield* gatewayError(
            "controller_runtime_stale",
            "The exact controller runtime is no longer active.",
          );
        }
        const turn = yield* provider
          .sendTurn({
            threadId: input.controllerThreadId,
            input: input.input,
            clientUserMessageId: MessageId.make(input.clientUserMessageId),
            expectedTurnId: null,
            recoveryPolicy: "forbid",
          })
          .pipe(
            mapProviderFailure(
              "controller_turn_start_failed",
              "The explicit controller action turn could not be started.",
            ),
          );
        return {
          codexProviderThreadId: session.providerThreadId,
          turnId: turn.turnId,
        };
      }),
    awaitControllerAction: (input) =>
      Effect.gen(function* () {
        const session = (yield* provider.listSessions()).find((candidate) =>
          isExactRuntime(candidate, input.controllerThreadId, input.controllerRuntimeInstanceId),
        );
        if (session === undefined) {
          return yield* gatewayError(
            "controller_runtime_stale",
            "The exact controller runtime is no longer active.",
          );
        }
        const authoritativeOutcome =
          provider.readThread === undefined
            ? Effect.gen(function* () {
                const key = turnKey(input.controllerThreadId, input.turnId);
                const waiter = yield* Deferred.make<ControllerOutcome>();
                const immediate = yield* Ref.modify(controllerTurns, (states) => {
                  const current = states.get(key) ?? { text: "", waiters: [] };
                  if (current.outcome !== undefined) {
                    return [current.outcome, states] as const;
                  }
                  const next = new Map(states);
                  next.set(key, { ...current, waiters: [...current.waiters, waiter] });
                  return [undefined, next] as const;
                });
                return immediate ?? (yield* Deferred.await(waiter));
              })
            : awaitPersistedControllerOutcome(input.controllerThreadId, input.turnId);
        const outcome = yield* authoritativeOutcome.pipe(Effect.timeoutOption(ACTION_TIMEOUT));
        if (Option.isNone(outcome)) {
          return yield* gatewayError(
            "controller_turn_timeout",
            "The controller action did not reach a terminal state before the deadline.",
          );
        }
        return outcome.value;
      }),
    appendTransportText: (input) =>
      provider
        .appendRealtimeText({
          threadId: input.transportThreadId,
          generation: input.generation,
          text: input.text,
          role: "assistant",
        })
        .pipe(
          mapProviderFailure(
            "append_text_failed",
            "The controller result could not be appended to the voice transport.",
          ),
        ),
    appendTransportSpeech: (input) =>
      provider
        .appendRealtimeSpeech({
          threadId: input.transportThreadId,
          generation: input.generation,
          text: input.text,
        })
        .pipe(
          mapProviderFailure(
            "append_speech_failed",
            "The controller result could not be queued for speech.",
          ),
        ),
    streamEvents: Stream.fromPubSub(gatewayEvents),
  });
});

export const VoiceRuntimeGatewayLive = Layer.effect(VoiceRuntimeGateway, makeVoiceRuntimeGateway());
