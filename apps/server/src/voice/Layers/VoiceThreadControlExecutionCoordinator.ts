import type { ThreadId } from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";

import {
  completeClaimedMutationDispatch,
  ThreadControlExecutionCoordinator,
} from "../../orchestration/Services/ThreadControlExecutionCoordinator.ts";
import {
  ThreadControlError,
  type ControllerActionContext,
  type VoiceControllerActionContext,
  type ThreadControlAuthorization,
} from "../../orchestration/Services/ThreadControlService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepository } from "../../persistence/Services/VoiceControllerMutations.ts";
import { reconcileVoiceMutationOutcomes } from "../VoiceMutationOutcomeReconciler.ts";

const operationId = (action: VoiceControllerActionContext, operation: string): string =>
  `voice:${action.voiceActionId}:${operation}`;

const requireVoiceAction = (
  action: ControllerActionContext,
): Effect.Effect<VoiceControllerActionContext, ThreadControlError> =>
  action.adapterKind === "voice-controller"
    ? Effect.succeed(action)
    : Effect.fail(
        new ThreadControlError({
          code: "controller_mismatch",
          message: "The mutation action is not owned by the Voice adapter.",
        }),
      );

export const makeVoiceThreadControlExecutionCoordinator = Effect.fn(
  "VoiceThreadControlExecutionCoordinator.make",
)(function* () {
  const engine = yield* OrchestrationEngineService;
  const bindings = yield* VoiceControllerBindingRepository;
  const mutations = yield* VoiceControllerMutationRepository;
  const crypto = yield* Crypto.Crypto;

  const setActiveTarget = Effect.fn("VoiceThreadControlExecutionCoordinator.setActiveTarget")(
    function* (authorization: ThreadControlAuthorization, targetThreadId: ThreadId) {
      yield* bindings
        .setActiveTarget({
          environmentId: authorization.environmentId,
          controllerThreadId: authorization.controllerThreadId,
          expectedControlEpoch: authorization.controlEpoch,
          activeTargetThreadId: targetThreadId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.ignore);
    },
  );

  const clearActiveTargetIfMatching = Effect.fn(
    "VoiceThreadControlExecutionCoordinator.clearActiveTargetIfMatching",
  )(function* (authorization: ThreadControlAuthorization, targetThreadId: ThreadId) {
    yield* bindings
      .clearActiveTargetIfMatches({
        environmentId: authorization.environmentId,
        controllerThreadId: authorization.controllerThreadId,
        expectedControlEpoch: authorization.controlEpoch,
        expectedActiveTargetThreadId: targetThreadId,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.ignore);
  });

  const requestHash = (canonicalRequest: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(canonicalRequest)).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "dispatch_failed",
            message: "The voice mutation request could not be authenticated.",
          }),
      ),
    );

  const execute: ThreadControlExecutionCoordinator["Service"]["execute"] = Effect.fn(
    "VoiceThreadControlExecutionCoordinator.execute",
  )(function* (input) {
    const action = yield* requireVoiceAction(input.action);
    const claimedAt = yield* DateTime.now;
    const claimedAtIso = DateTime.formatIso(claimedAt);
    const mutationKey = `voice:${action.voiceActionId}:thread-control`;
    const canonicalRequestHash = yield* requestHash(input.canonicalRequest);
    const claimed = yield* mutations
      .claimOrReplay({
        voiceActionId: action.voiceActionId,
        mutationKey,
        toolName: input.toolName,
        semanticSlot: input.semanticSlot,
        canonicalRequestHash,
        operationId: operationId(action, input.operation),
        providerCreationId: input.providerCreationId,
        bindingGeneration: input.authorization.bindingGeneration,
        controlEpoch: input.authorization.controlEpoch,
        createdAt: claimedAtIso,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The voice mutation could not be durably claimed.",
            }),
        ),
      );
    if (claimed._tag === "conflict" || claimed._tag === "action_unavailable") {
      return yield* new ThreadControlError({
        code: "dispatch_failed",
        message:
          claimed._tag === "conflict"
            ? "This controller action already claimed a different thread mutation."
            : "This controller action is no longer available for mutation.",
      });
    }
    if (
      claimed._tag === "replay" &&
      claimed.mutation.dispatchState !== "never_dispatched" &&
      claimed.mutation.dispatchState !== "claimed"
    ) {
      return yield* new ThreadControlError({
        code: "dispatch_failed",
        message: "The prior voice mutation is already dispatched and is being reconciled.",
      });
    }
    const claimOwner = `${mutationKey}:dispatcher`;
    const dispatchClaimed = yield* mutations
      .claimDispatch({
        voiceActionId: action.voiceActionId,
        claimOwner,
        claimExpiresAt: DateTime.formatIso(DateTime.add(claimedAt, { minutes: 1 })),
        claimedAt: claimedAtIso,
        expectedBindingGeneration: input.authorization.bindingGeneration,
        expectedControlEpoch: input.authorization.controlEpoch,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The voice mutation dispatch claim failed.",
            }),
        ),
      );
    if (!dispatchClaimed) {
      return yield* new ThreadControlError({
        code: "dispatch_failed",
        message: "The voice mutation dispatch was fenced before it started.",
      });
    }
    yield* input.revalidate.pipe(
      Effect.tapError(() =>
        mutations
          .releaseClaim({
            voiceActionId: action.voiceActionId,
            claimOwner,
            mayHavePersistedIntents: false,
            updatedAt: DateTime.formatIso(claimedAt),
          })
          .pipe(Effect.ignore),
      ),
    );
    const result = yield* completeClaimedMutationDispatch({
      dispatchIntents: input.dispatch({
        toolName: input.toolName,
        operation: input.operation,
        canonicalRequestHash,
      }),
      releaseClaim: (mayHavePersistedIntents) =>
        mutations
          .releaseClaim({
            voiceActionId: action.voiceActionId,
            claimOwner,
            mayHavePersistedIntents,
            updatedAt: DateTime.formatIso(claimedAt),
          })
          .pipe(Effect.ignore),
      markDispatched: () =>
        Effect.gen(function* () {
          const dispatchedAt = DateTime.formatIso(yield* DateTime.now);
          return yield* mutations
            .markDispatched({
              voiceActionId: action.voiceActionId,
              claimOwner,
              dispatchedAt,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new ThreadControlError({
                    code: "dispatch_failed",
                    message: "The voice mutation dispatch boundary could not be persisted.",
                  }),
              ),
            );
        }),
      reconcileOutcome: () =>
        reconcileVoiceMutationOutcomes({ engine, mutations }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("voice mutation post-dispatch outcome reconciliation failed", {
              voiceActionId: input.action.voiceActionId,
              operationId: operationId(action, input.operation),
              cause,
            }),
          ),
        ),
    });
    yield* setActiveTarget(input.authorization, input.targetThreadId);
    return result;
  });

  return ThreadControlExecutionCoordinator.of({
    execute,
    setActiveTarget,
    clearActiveTargetIfMatching,
  });
});

export const VoiceThreadControlExecutionCoordinatorLive = Layer.effect(
  ThreadControlExecutionCoordinator,
  makeVoiceThreadControlExecutionCoordinator(),
);
