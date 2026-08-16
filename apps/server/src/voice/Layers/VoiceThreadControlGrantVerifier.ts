import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ThreadControlGrantVerifier } from "../../orchestration/Services/ThreadControlGrantVerifier.ts";
import {
  ThreadControlError,
  type ControllerActionContext,
  type ThreadControlAuthorization,
} from "../../orchestration/Services/ThreadControlService.ts";
import { VoiceControllerActionRepository } from "../../persistence/Services/VoiceControllerActions.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceTransportSessionRepository } from "../../persistence/Services/VoiceTransportSessions.ts";
import { resolveVoiceControlPolicy, ServerSettingsService } from "../../serverSettings.ts";

export const makeVoiceThreadControlGrantVerifier = Effect.fn(
  "VoiceThreadControlGrantVerifier.make",
)(function* () {
  const environment = yield* ServerEnvironment;
  const bindings = yield* VoiceControllerBindingRepository;
  const actions = yield* VoiceControllerActionRepository;
  const transports = yield* VoiceTransportSessionRepository;
  const settings = yield* ServerSettingsService;

  const authorize = Effect.fn("VoiceThreadControlGrantVerifier.authorize")(function* (
    authorization: ThreadControlAuthorization,
    operation: "read" | "control",
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    if (authorization.environmentId !== environmentId) {
      return yield* new ThreadControlError({
        code: "environment_mismatch",
        message: "The controller grant is for a different environment.",
      });
    }
    const policy = resolveVoiceControlPolicy(
      yield* settings.getSettings.pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "read_disabled",
              message: "The live voice policy could not be read.",
            }),
        ),
      ),
    );
    if (!authorization.canRead || !policy.read) {
      return yield* new ThreadControlError({
        code: "read_disabled",
        message: "Voice thread reads are disabled.",
      });
    }
    if (operation === "control" && (!authorization.canControl || !policy.control)) {
      return yield* new ThreadControlError({
        code: "control_disabled",
        message: "Voice thread control is disabled.",
      });
    }
    const binding = yield* bindings.getByEnvironmentId(environmentId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "controller_mismatch",
            message: "The live controller binding could not be read.",
          }),
      ),
    );
    if (
      Option.isNone(binding) ||
      binding.value.controllerThreadId !== authorization.controllerThreadId ||
      binding.value.providerInstanceId !== authorization.providerInstanceId ||
      binding.value.authorizedRuntimeCeiling !== authorization.authorizedRuntimeCeiling ||
      binding.value.bindingGeneration !== authorization.bindingGeneration ||
      binding.value.state !== "active"
    ) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The controller credential no longer matches the live binding.",
      });
    }
    if (operation === "control" && binding.value.controlEpoch !== authorization.controlEpoch) {
      return yield* new ThreadControlError({
        code: "control_disabled",
        message: "The controller credential belongs to an obsolete control epoch.",
      });
    }
  });

  const validateMutation = Effect.fn("VoiceThreadControlGrantVerifier.validateMutation")(function* (
    authorization: ThreadControlAuthorization,
    action: ControllerActionContext,
  ) {
    if (action.controllerThreadId !== authorization.controllerThreadId) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The action is not bound to this controller.",
      });
    }
    const persisted = yield* actions.getById(action.voiceActionId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "controller_mismatch",
            message: "The live controller action could not be read.",
          }),
      ),
    );
    if (
      Option.isNone(persisted) ||
      persisted.value.state !== "active" ||
      persisted.value.closedAt !== null ||
      persisted.value.controllerThreadId !== authorization.controllerThreadId ||
      persisted.value.transportSessionId !== action.transportSessionId ||
      persisted.value.transportRuntimeInstanceId !== action.runtimeInstanceId ||
      persisted.value.transportGeneration !== action.transportGeneration ||
      persisted.value.controllerRuntimeInstanceId !== action.controllerRuntimeInstanceId ||
      persisted.value.controllerProviderSessionId !== action.controllerCodexProviderThreadId ||
      persisted.value.controllerProviderTurnId !== action.controllerProviderTurnId
    ) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The controller action is closed, stale, or no longer matches its provider turn.",
      });
    }
    const transport = yield* transports.getById(action.transportSessionId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "controller_mismatch",
            message: "The live voice transport could not be read.",
          }),
      ),
    );
    if (
      Option.isNone(transport) ||
      transport.value.state !== "active" ||
      transport.value.controllerThreadId !== authorization.controllerThreadId ||
      transport.value.runtimeInstanceId !== action.runtimeInstanceId ||
      transport.value.generation !== action.transportGeneration
    ) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The voice transport generation has been fenced.",
      });
    }
  });

  return ThreadControlGrantVerifier.of({ authorize, validateMutation });
});

export const VoiceThreadControlGrantVerifierLive = Layer.effect(
  ThreadControlGrantVerifier,
  makeVoiceThreadControlGrantVerifier(),
);
