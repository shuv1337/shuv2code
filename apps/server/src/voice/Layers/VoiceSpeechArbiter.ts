import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  VoiceSpeechArbiter,
  type VoiceSpeechAttempt,
  type VoiceSpeechArbiterShape,
  type VoiceSpeechCompletion,
} from "../Services/VoiceSpeechArbiter.ts";
import type { ActiveVoiceSession } from "../Services/VoiceTransportCoordinator.ts";
import { VoiceRuntimeGateway } from "../Services/VoiceRuntimeGateway.ts";
import { VOICE_TRANSPORT_FEEDBACK_TIMEOUT } from "../VoiceTransportFeedback.ts";

interface ActiveAttempt {
  readonly attempt: VoiceSpeechAttempt;
  readonly deliveredText: string | null;
  readonly providerItemId: import("@shuv2code/contracts").VoiceTranscriptItemId | null;
  readonly interrupted: boolean;
}

interface CallSpeechState {
  readonly generation: number;
  readonly providerBusy: boolean;
  readonly active: ActiveAttempt | null;
  readonly authoredQueue: ReadonlyArray<VoiceSpeechAttempt>;
  readonly commentaryQueue: ReadonlyArray<VoiceSpeechAttempt>;
  readonly pendingAmbient: VoiceSpeechAttempt | null;
}

const MAX_COMMENTARY_QUEUE = 8;

const emptyCallState = (session: ActiveVoiceSession): CallSpeechState => ({
  generation: session.fence.generation,
  providerBusy: false,
  active: null,
  authoredQueue: [],
  commentaryQueue: [],
  pendingAmbient: null,
});

const sessionKey = (session: ActiveVoiceSession): string => session.transportSessionId;

const stateFor = (
  states: ReadonlyMap<string, CallSpeechState>,
  session: ActiveVoiceSession,
): CallSpeechState => {
  const current = states.get(sessionKey(session));
  return current?.generation === session.fence.generation ? current : emptyCallState(session);
};

const sameSemanticText = (left: string, right: string): boolean =>
  left.trim().replaceAll(/\s+/g, " ").toLowerCase() ===
  right.trim().replaceAll(/\s+/g, " ").toLowerCase();

const completionFrom = (
  active: ActiveAttempt,
  completedAt: string,
): VoiceSpeechCompletion | undefined =>
  !active.interrupted && active.deliveredText !== null && active.providerItemId !== null
    ? {
        ...active.attempt,
        deliveredText: active.deliveredText,
        providerItemId: active.providerItemId,
        completedAt,
      }
    : undefined;

export const makeVoiceSpeechArbiter = Effect.fn("VoiceSpeechArbiter.make")(function* (
  sendSpeech: (attempt: VoiceSpeechAttempt) => Effect.Effect<void, object>,
) {
  const statesRef = yield* Ref.make(new Map<string, CallSpeechState>());
  const stateMutex = yield* Semaphore.make(1);

  const selectNext = Effect.fn("VoiceSpeechArbiter.selectNext")(function* (
    session: ActiveVoiceSession,
  ) {
    return yield* stateMutex.withPermits(1)(
      Ref.modify(statesRef, (states) => {
        const key = sessionKey(session);
        const current = stateFor(states, session);
        if (current.providerBusy || current.active !== null) {
          return [undefined, states] as const;
        }
        const nextAttempt =
          current.authoredQueue[0] ??
          current.commentaryQueue[0] ??
          current.pendingAmbient ??
          undefined;
        if (nextAttempt === undefined) return [undefined, states] as const;
        const nextState: CallSpeechState = {
          ...current,
          active: {
            attempt: nextAttempt,
            deliveredText: null,
            providerItemId: null,
            interrupted: false,
          },
          authoredQueue:
            current.authoredQueue[0] === nextAttempt
              ? current.authoredQueue.slice(1)
              : current.authoredQueue,
          commentaryQueue:
            current.commentaryQueue[0] === nextAttempt
              ? current.commentaryQueue.slice(1)
              : current.commentaryQueue,
          pendingAmbient: current.pendingAmbient === nextAttempt ? null : current.pendingAmbient,
        };
        const next = new Map(states);
        next.set(key, nextState);
        return [nextAttempt, next] as const;
      }),
    );
  });

  const clearFailedAttempt = Effect.fn("VoiceSpeechArbiter.clearFailedAttempt")(function* (
    attempt: VoiceSpeechAttempt,
  ) {
    yield* stateMutex.withPermits(1)(
      Ref.update(statesRef, (states) => {
        const key = sessionKey(attempt.session);
        const current = stateFor(states, attempt.session);
        if (current.active?.attempt.attemptId !== attempt.attemptId) return states;
        const next = new Map(states);
        next.set(key, { ...current, providerBusy: false, active: null });
        return next;
      }),
    );
  });

  const startNext: (session: ActiveVoiceSession) => Effect.Effect<void> = Effect.fn(
    "VoiceSpeechArbiter.startNext",
  )(function* (session) {
    const selected = yield* selectNext(session);
    if (selected === undefined) return;
    const sent = yield* Effect.exit(sendSpeech(selected));
    if (sent._tag === "Success") {
      yield* Effect.sleep("45 seconds").pipe(
        Effect.andThen(clearFailedAttempt(selected)),
        Effect.andThen(startNext(session)),
        Effect.forkDetach,
      );
      return;
    }
    yield* clearFailedAttempt(selected);
    yield* startNext(session);
  });

  const enqueue: VoiceSpeechArbiterShape["enqueue"] = Effect.fn("VoiceSpeechArbiter.enqueue")(
    function* (attempt) {
      const accepted = yield* stateMutex.withPermits(1)(
        Ref.modify(statesRef, (states) => {
          const key = sessionKey(attempt.session);
          const current = stateFor(states, attempt.session);
          if (
            (attempt.source === "ambient" || attempt.source === "commentary") &&
            current.active?.attempt.source === attempt.source &&
            sameSemanticText(current.active.attempt.requestedText, attempt.requestedText)
          ) {
            return [false, states] as const;
          }
          const next = new Map(states);
          if (attempt.source === "authored" || attempt.source === "controller") {
            next.set(key, {
              ...current,
              authoredQueue: [...current.authoredQueue, attempt],
              pendingAmbient: null,
            });
          } else if (attempt.source === "commentary") {
            const duplicate = current.commentaryQueue.some((queued) =>
              sameSemanticText(queued.requestedText, attempt.requestedText),
            );
            if (duplicate) return [false, states] as const;
            next.set(key, {
              ...current,
              commentaryQueue: [...current.commentaryQueue, attempt].slice(-MAX_COMMENTARY_QUEUE),
              pendingAmbient: null,
            });
          } else {
            next.set(key, {
              ...current,
              pendingAmbient:
                current.pendingAmbient !== null &&
                sameSemanticText(current.pendingAmbient.requestedText, attempt.requestedText)
                  ? current.pendingAmbient
                  : attempt,
            });
          }
          return [true, next] as const;
        }),
      );
      if (!accepted) return false;
      yield* startNext(attempt.session);
      return true;
    },
  );

  const observeOutputStarted: VoiceSpeechArbiterShape["observeOutputStarted"] = Effect.fn(
    "VoiceSpeechArbiter.observeOutputStarted",
  )(function* (session) {
    yield* stateMutex.withPermits(1)(
      Ref.update(statesRef, (states) => {
        const next = new Map(states);
        const current = stateFor(states, session);
        next.set(sessionKey(session), { ...current, providerBusy: true });
        return next;
      }),
    );
  });

  const completeActive = Effect.fn("VoiceSpeechArbiter.completeActive")(function* (
    session: ActiveVoiceSession,
    occurredAt: string,
  ) {
    const completion = yield* stateMutex.withPermits(1)(
      Ref.modify(statesRef, (states) => {
        const current = stateFor(states, session);
        const completion =
          current.active === null ? undefined : completionFrom(current.active, occurredAt);
        const next = new Map(states);
        next.set(sessionKey(session), {
          ...current,
          providerBusy: false,
          active: null,
        });
        return [completion, next] as const;
      }),
    );
    yield* startNext(session);
    return completion;
  });

  const observeOutputDone: VoiceSpeechArbiterShape["observeOutputDone"] = Effect.fn(
    "VoiceSpeechArbiter.observeOutputDone",
  )(function* (session, occurredAt) {
    return yield* completeActive(session, occurredAt);
  });

  const observeTranscript: VoiceSpeechArbiterShape["observeTranscript"] = Effect.fn(
    "VoiceSpeechArbiter.observeTranscript",
  )(function* (input) {
    const observed = yield* stateMutex.withPermits(1)(
      Ref.modify(
        statesRef,
        (
          states,
        ): readonly [
          import("../Services/VoiceSpeechArbiter.ts").VoiceSpeechTranscriptObservation,
          Map<string, CallSpeechState>,
        ] => {
          const current = stateFor(states, input.session);
          if (current.active === null) {
            const next = new Map(states);
            next.set(sessionKey(input.session), {
              ...current,
              providerBusy: !input.outputDone,
            });
            return [{ claimed: false } as const, next] as const;
          }
          const active: ActiveAttempt = {
            ...current.active,
            deliveredText: input.text,
            providerItemId: input.itemId,
          };
          const completion = input.outputDone
            ? completionFrom(active, input.occurredAt)
            : undefined;
          const next = new Map(states);
          next.set(sessionKey(input.session), {
            ...current,
            providerBusy: !input.outputDone,
            active: input.outputDone ? null : active,
          });
          return [
            {
              claimed: true,
              ...(completion === undefined ? {} : { completion }),
            } as const,
            next,
          ] as const;
        },
      ),
    );
    if (input.outputDone) yield* startNext(input.session);
    return observed;
  });

  const observeUserSpeech: VoiceSpeechArbiterShape["observeUserSpeech"] = Effect.fn(
    "VoiceSpeechArbiter.observeUserSpeech",
  )(function* (session) {
    yield* stateMutex.withPermits(1)(
      Ref.update(statesRef, (states) => {
        const current = stateFor(states, session);
        const next = new Map(states);
        next.set(sessionKey(session), {
          ...current,
          providerBusy: true,
          active: current.active === null ? null : { ...current.active, interrupted: true },
          commentaryQueue: [],
          pendingAmbient: null,
        });
        return next;
      }),
    );
  });

  const cancelAmbient: VoiceSpeechArbiterShape["cancelAmbient"] = Effect.fn(
    "VoiceSpeechArbiter.cancelAmbient",
  )(function* (session) {
    yield* stateMutex.withPermits(1)(
      Ref.update(statesRef, (states) => {
        const current = stateFor(states, session);
        if (current.pendingAmbient === null) return states;
        const next = new Map(states);
        next.set(sessionKey(session), { ...current, pendingAmbient: null });
        return next;
      }),
    );
  });

  const close: VoiceSpeechArbiterShape["close"] = Effect.fn("VoiceSpeechArbiter.close")(
    function* (session) {
      yield* stateMutex.withPermits(1)(
        Ref.update(statesRef, (states) => {
          const next = new Map(states);
          next.delete(sessionKey(session));
          return next;
        }),
      );
    },
  );

  return VoiceSpeechArbiter.of({
    enqueue,
    observeOutputStarted,
    observeOutputDone,
    observeTranscript,
    observeUserSpeech,
    cancelAmbient,
    close,
  });
});

export const VoiceSpeechArbiterLive = Layer.effect(
  VoiceSpeechArbiter,
  Effect.gen(function* () {
    const runtime = yield* VoiceRuntimeGateway;
    return yield* makeVoiceSpeechArbiter((attempt) =>
      runtime
        .appendTransportSpeech({
          transportThreadId: attempt.session.fence.transportThreadId,
          generation: attempt.session.fence.generation,
          text: attempt.requestedText,
        })
        .pipe(Effect.timeout(VOICE_TRANSPORT_FEEDBACK_TIMEOUT)),
    );
  }),
);
