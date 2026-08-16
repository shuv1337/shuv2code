import { TurnId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ThreadControlInvocationError,
  ThreadControlInvocationResolver,
  type ThreadControlOperation,
} from "../orchestration/Services/ThreadControlInvocationResolver.ts";
import {
  ThreadControlError,
  type ThreadControlAuthorization,
} from "../orchestration/Services/ThreadControlService.ts";
import type { VoiceControllerBindingRepository } from "../persistence/Services/VoiceControllerBindings.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ControllerActionContextResolver } from "./Services/ControllerActionContextResolver.ts";
import type { ControllerMcpRequestScope, McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export interface VoiceThreadControlInvocationResolverInput {
  readonly invocation: McpInvocationScope;
  readonly request: ControllerMcpRequestScope;
  readonly settingsService: ServerSettings.ServerSettingsService["Service"];
  readonly bindingRepository: VoiceControllerBindingRepository["Service"];
  readonly actionResolver: ControllerActionContextResolver["Service"];
}

const authorizationError = (message: string) =>
  new ThreadControlError({
    code: "controller_mismatch",
    message,
  });

const settingsFailure = () =>
  new ThreadControlError({
    code: "dispatch_failed",
    message: "The live voice-control policy could not be read.",
  });

const bindingFailure = () =>
  new ThreadControlError({
    code: "dispatch_failed",
    message: "The live controller binding could not be verified.",
  });

export function makeVoiceThreadControlInvocationResolver(
  input: VoiceThreadControlInvocationResolverInput,
): ThreadControlInvocationResolver["Service"] {
  const requireControllerInvocation = Effect.fn(
    "VoiceThreadControlInvocationResolver.requireControllerInvocation",
  )(function* () {
    if (input.invocation.profile.kind !== "voice-controller") {
      return yield* authorizationError("A designated voice-controller credential is required.");
    }
    return { ...input.invocation, profile: input.invocation.profile };
  });

  const resolveAuthorization = Effect.fn(
    "VoiceThreadControlInvocationResolver.resolveAuthorization",
  )(function* (operation: ThreadControlOperation) {
    const invocation = yield* requireControllerInvocation();
    if (!invocation.capabilities.has("threads.read")) {
      return yield* authorizationError("Voice thread reads are not granted.");
    }

    const settings = yield* input.settingsService.getSettings.pipe(
      Effect.mapError(settingsFailure),
    );
    const policy = ServerSettings.resolveVoiceControlPolicy(settings);
    if (!policy.read) {
      return yield* new ThreadControlError({
        code: "read_disabled",
        message: "Voice thread reads are disabled by live server policy.",
      });
    }

    const binding = yield* input.bindingRepository
      .getByControllerThreadId(invocation.profile.controllerThreadId)
      .pipe(Effect.mapError(bindingFailure));
    if (Option.isNone(binding)) {
      return yield* authorizationError("The controller designation is no longer active.");
    }
    if (
      binding.value.environmentId !== invocation.environmentId ||
      binding.value.controllerThreadId !== invocation.profile.controllerThreadId ||
      binding.value.providerInstanceId !== invocation.providerInstanceId ||
      binding.value.state === "resetting"
    ) {
      return yield* authorizationError(
        "The controller credential does not match the live designation.",
      );
    }

    const epochMatches = binding.value.controlEpoch === invocation.profile.controlEpoch;
    const credentialControls = invocation.capabilities.has("threads.control");
    const canControl = policy.control && credentialControls && epochMatches;
    if (operation === "control" && !canControl) {
      return yield* new ThreadControlError({
        code: "control_disabled",
        message: epochMatches
          ? "Voice thread control is disabled by live server policy."
          : "This controller credential belongs to a stale control epoch.",
      });
    }

    return {
      environmentId: invocation.environmentId,
      controllerThreadId: invocation.profile.controllerThreadId,
      providerInstanceId: invocation.providerInstanceId,
      authorizedRuntimeCeiling: binding.value.authorizedRuntimeCeiling,
      liveControllerRuntimeMode: invocation.profile.liveControllerRuntimeMode,
      bindingGeneration: binding.value.bindingGeneration,
      controlEpoch: binding.value.controlEpoch,
      canRead: true,
      canControl,
    } satisfies ThreadControlAuthorization;
  });

  const resolveMutation = Effect.fn("VoiceThreadControlInvocationResolver.resolveMutation")(
    function* () {
      const authorization = yield* resolveAuthorization("control");
      const invocation = yield* requireControllerInvocation();
      const metadata = input.request.turnMetadata;
      if (metadata === undefined) {
        return yield* new ThreadControlInvocationError({
          code: "action_not_found",
          message: "Trusted provider turn metadata is required for controller mutations.",
        });
      }
      const action = yield* input.actionResolver
        .resolve({
          controllerThreadId: invocation.profile.controllerThreadId,
          controllerRuntimeInstanceId: invocation.profile.runtimeInstanceId,
          codexProviderThreadId: metadata.threadId,
          providerTurnId: TurnId.make(metadata.turnId),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ThreadControlInvocationError({
                code: error.code,
                message: error.message,
              }),
          ),
        );
      return { authorization, action };
    },
  );

  return ThreadControlInvocationResolver.of({
    resolveAuthorization,
    resolveMutation,
  });
}

export const __testing = {
  authorizationError,
};
