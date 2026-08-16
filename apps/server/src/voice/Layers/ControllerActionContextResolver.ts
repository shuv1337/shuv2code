import { VoiceActionId, VoiceRuntimeInstanceId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VoiceControllerActionRepository } from "../../persistence/Services/VoiceControllerActions.ts";
import {
  ControllerActionContextError,
  ControllerActionContextResolver,
  makeControllerActionContext,
} from "../Services/ControllerActionContextResolver.ts";

export const ControllerActionContextResolverLive = Layer.effect(
  ControllerActionContextResolver,
  Effect.gen(function* () {
    const actions = yield* VoiceControllerActionRepository;

    return ControllerActionContextResolver.of({
      resolve: Effect.fn("ControllerActionContextResolver.resolve")(function* (input) {
        const action = yield* actions
          .resolveOpenByControllerTurn({
            controllerThreadId: input.controllerThreadId,
            controllerRuntimeInstanceId: input.controllerRuntimeInstanceId,
            controllerProviderSessionId: input.codexProviderThreadId,
            controllerProviderTurnId: input.providerTurnId,
          })
          .pipe(
            Effect.mapError(
              () =>
                new ControllerActionContextError({
                  code: "action_not_found",
                  message: "The controller action could not be resolved.",
                }),
            ),
          );
        if (Option.isNone(action)) {
          return yield* new ControllerActionContextError({
            code: "action_not_found",
            message: "No open action matches the controller provider turn.",
          });
        }
        if (action.value.controllerThreadId !== input.controllerThreadId) {
          return yield* new ControllerActionContextError({
            code: "controller_mismatch",
            message: "The action belongs to a different controller.",
          });
        }
        if (action.value.controllerRuntimeInstanceId !== input.controllerRuntimeInstanceId) {
          return yield* new ControllerActionContextError({
            code: "transport_generation_fenced",
            message: "The controller runtime instance has been replaced.",
          });
        }
        if (action.value.controllerProviderSessionId !== input.codexProviderThreadId) {
          return yield* new ControllerActionContextError({
            code: "provider_session_mismatch",
            message: "The provider session does not match the action.",
          });
        }
        if (action.value.controllerProviderTurnId !== input.providerTurnId) {
          return yield* new ControllerActionContextError({
            code: "provider_turn_mismatch",
            message: "The provider turn does not match the action.",
          });
        }

        return makeControllerActionContext({
          voiceActionId: VoiceActionId.make(action.value.voiceActionId),
          controllerThreadId: action.value.controllerThreadId,
          transportSessionId: action.value.transportSessionId,
          controllerCodexProviderThreadId: input.codexProviderThreadId,
          controllerProviderTurnId: input.providerTurnId,
          controllerRuntimeInstanceId: VoiceRuntimeInstanceId.make(
            action.value.controllerRuntimeInstanceId,
          ),
          transportGeneration: action.value.transportGeneration,
          runtimeInstanceId: VoiceRuntimeInstanceId.make(action.value.transportRuntimeInstanceId),
        });
      }),
    });
  }),
);
