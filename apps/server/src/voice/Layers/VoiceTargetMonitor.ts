import { VoiceActionId, type VoiceTargetPhase } from "@shuv2code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VoiceControllerActionRepository } from "../../persistence/Services/VoiceControllerActions.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepository } from "../../persistence/Services/VoiceControllerMutations.ts";
import {
  VoiceTargetMonitor,
  type VoiceTargetMonitorShape,
  type WatchedVoiceTarget,
} from "../Services/VoiceTargetMonitor.ts";
import { VoiceTransportCoordinator } from "../Services/VoiceTransportCoordinator.ts";
import {
  claimVoiceTargetPhase,
  targetPhaseOf,
  targetThreadIdFromVoiceMutation,
  voiceTargetStatusText,
} from "./voiceControllerShared.ts";

export const makeVoiceTargetMonitor = Effect.fn("VoiceTargetMonitor.make")(function* () {
  const projection = yield* ProjectionSnapshotQuery;
  const bindings = yield* VoiceControllerBindingRepository;
  const actions = yield* VoiceControllerActionRepository;
  const mutations = yield* VoiceControllerMutationRepository;
  const transport = yield* VoiceTransportCoordinator;
  const watchedTargetsRef = yield* Ref.make(new Map<string, WatchedVoiceTarget>());
  const watchedTargetPhasesRef = yield* Ref.make(new Map<string, VoiceTargetPhase>());

  const watchTarget: VoiceTargetMonitorShape["watchTarget"] = (watch) =>
    Ref.update(watchedTargetsRef, (watches) => {
      const next = new Map(watches);
      next.set(`${watch.voiceActionId}\u0000${watch.targetThreadId}`, watch);
      return next;
    });

  const clearActiveTargetIfMatching = Effect.fn("VoiceTargetMonitor.clearActiveTargetIfMatching")(
    function* (
      session: {
        readonly environmentId: import("@shuv2code/contracts").EnvironmentId;
        readonly fence: { readonly controllerThreadId: import("@shuv2code/contracts").ThreadId };
        readonly controller: { readonly controlEpoch: number };
      },
      targetThreadId: import("@shuv2code/contracts").ThreadId,
    ) {
      yield* bindings
        .clearActiveTargetIfMatches({
          environmentId: session.environmentId,
          controllerThreadId: session.fence.controllerThreadId,
          expectedControlEpoch: session.controller.controlEpoch,
          expectedActiveTargetThreadId: targetThreadId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.ignore);
    },
  );

  const publishWatchedTarget: VoiceTargetMonitorShape["publishWatchedTarget"] = Effect.fn(
    "VoiceTargetMonitor.publishWatchedTarget",
  )(function* (watch) {
    const sessions = yield* transport.getSessions();
    const session = Array.from(sessions.values()).find(
      (candidate) => candidate.transportSessionId === watch.transportSessionId,
    );
    if (session === undefined || session.controller === null) return;
    const controllerSession = { ...session, controller: session.controller };
    const shell = yield* projection.getShellSnapshot().pipe(Effect.orElseSucceed(() => undefined));
    if (shell === undefined) return;
    const target = shell.threads.find((thread) => thread.id === watch.targetThreadId);
    if (target === undefined) {
      yield* clearActiveTargetIfMatching(controllerSession, watch.targetThreadId);
      return;
    }
    const project = shell.projects.find((candidate) => candidate.id === target.projectId);
    if (project === undefined || target.purpose !== "standard") {
      yield* clearActiveTargetIfMatching(controllerSession, watch.targetThreadId);
      return;
    }
    const phase = targetPhaseOf(target);
    const shouldEmit = yield* claimVoiceTargetPhase(watchedTargetPhasesRef, watch, phase);
    if (!shouldEmit) return;
    const statusText = voiceTargetStatusText({
      projectTitle: project.title,
      threadTitle: target.title,
      phase,
    });
    yield* transport.emit(session.fence.clientSessionId, {
      type: "target.status",
      voiceActionId: watch.voiceActionId,
      targetThreadId: target.id,
      targetProjectId: target.projectId,
      projectTitle: project.title,
      threadTitle: target.title,
      phase,
      statusText,
      activeTurnId: target.session?.activeTurnId ?? null,
      snapshotSequence: shell.snapshotSequence,
      observedAt: shell.updatedAt,
    });
    yield* transport.deliverAssistantUpdate({
      session,
      kind: "target_phase",
      text: statusText,
      voiceActionId: watch.voiceActionId,
      targetThreadId: target.id,
      phase,
    });
  });

  const seedWatchedTargets: VoiceTargetMonitorShape["seedWatchedTargets"] = Effect.fn(
    "VoiceTargetMonitor.seedWatchedTargets",
  )(function* (session) {
    const durableActions =
      actions.listRecentByControllerThreadId !== undefined
        ? yield* actions
            .listRecentByControllerThreadId(session.fence.controllerThreadId)
            .pipe(Effect.orElseSucceed(() => []))
        : actions.listByTransportSessionId !== undefined
          ? yield* actions
              .listByTransportSessionId(session.transportSessionId)
              .pipe(Effect.orElseSucceed(() => []))
          : [];
    yield* Effect.forEach(
      durableActions,
      (action) =>
        Effect.gen(function* () {
          const mutation = yield* mutations
            .getByActionId(action.voiceActionId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(mutation)) return;
          if (
            mutation.value.dispatchState === "never_dispatched" ||
            mutation.value.dispatchState === "claimed" ||
            mutation.value.dispatchState === "cancelled_by_policy"
          ) {
            return;
          }
          const targetThreadId = targetThreadIdFromVoiceMutation(mutation.value);
          if (targetThreadId === undefined) return;
          const watch = {
            voiceActionId: VoiceActionId.make(action.voiceActionId),
            transportSessionId: session.transportSessionId,
            targetThreadId,
          };
          yield* watchTarget(watch);
          yield* publishWatchedTarget(watch);
        }),
      { discard: true },
    );
  });

  const onDomainThreadEvent: VoiceTargetMonitorShape["onDomainThreadEvent"] = Effect.fn(
    "VoiceTargetMonitor.onDomainThreadEvent",
  )(function* (input) {
    const watches = Array.from((yield* Ref.get(watchedTargetsRef)).values()).filter(
      (watch) => watch.targetThreadId === input.targetThreadId,
    );
    yield* Effect.forEach(watches, publishWatchedTarget, { discard: true });
  });

  const claimPhase: VoiceTargetMonitorShape["claimPhase"] = (watch, phase) =>
    claimVoiceTargetPhase(watchedTargetPhasesRef, watch, phase);

  return VoiceTargetMonitor.of({
    watchTarget,
    publishWatchedTarget,
    seedWatchedTargets,
    onDomainThreadEvent,
    claimPhase,
  });
});

export const VoiceTargetMonitorLive = Layer.effect(VoiceTargetMonitor, makeVoiceTargetMonitor());
