import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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
import { VoiceCallEventRepository } from "../../persistence/Services/VoiceCallEvents.ts";
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

const MAX_COMPACTED_SPEECH_CHARS = 1_600;

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

const compactSpeechText = (texts: ReadonlyArray<string>): string => {
  const distinct: Array<string> = [];
  for (const text of texts) {
    const normalized = text.trim().replaceAll(/\s+/g, " ");
    if (normalized.length === 0) continue;
    if (distinct.some((entry) => sameSemanticText(entry, normalized))) continue;
    distinct.push(normalized);
  }
  const combined = distinct.join(" ");
  if (combined.length <= MAX_COMPACTED_SPEECH_CHARS) return combined;
  const tail = combined.slice(-MAX_COMPACTED_SPEECH_CHARS);
  const boundary = tail.indexOf(" ");
  return `Here is the latest state: ${tail.slice(boundary < 0 ? 0 : boundary + 1)}`;
};

const outputTerminalLease = (attempt: VoiceSpeechAttempt) =>
  `${Math.min(30, Math.max(12, Math.ceil(attempt.requestedText.length * 0.055 + 8)))} seconds`;

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
  observeLifecycle: (event: {
    readonly kind:
      | "speech.queued"
      | "speech.started"
      | "speech.completed"
      | "speech.interrupted"
      | "speech.failed";
    readonly attempt: VoiceSpeechAttempt;
    readonly occurredAt: string;
    readonly deliveredText?: string;
    readonly failureReason?: "transport-request-failed" | "output-timeout";
  }) => Effect.Effect<void> = () => Effect.void,
) {
  const statesRef = yield* Ref.make(new Map<string, CallSpeechState>());
  const failureQueue = yield* Queue.unbounded<VoiceSpeechAttempt>();
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

  const suspendFailedAttempt = Effect.fn("VoiceSpeechArbiter.suspendFailedAttempt")(function* (
    attempt: VoiceSpeechAttempt,
  ) {
    return yield* stateMutex.withPermits(1)(
      Ref.modify(statesRef, (states) => {
        const key = sessionKey(attempt.session);
        const current = stateFor(states, attempt.session);
        if (current.active?.attempt.attemptId !== attempt.attemptId) {
          return [false, states] as const;
        }
        const next = new Map(states);
        next.set(key, {
          ...current,
          providerBusy: true,
          active: null,
          authoredQueue: [],
          commentaryQueue: [],
          pendingAmbient: null,
        });
        return [true, next] as const;
      }),
    );
  });

  const failAndSuspend = Effect.fn("VoiceSpeechArbiter.failAndSuspend")(function* (
    attempt: VoiceSpeechAttempt,
    failureReason: "transport-request-failed" | "output-timeout",
  ) {
    const suspended = yield* suspendFailedAttempt(attempt);
    if (!suspended) return;
    yield* observeLifecycle({
      kind: "speech.failed",
      attempt,
      occurredAt: DateTime.formatIso(yield* DateTime.now),
      failureReason,
    });
    yield* Queue.offer(failureQueue, attempt);
  });

  const startNext: (session: ActiveVoiceSession) => Effect.Effect<void> = Effect.fn(
    "VoiceSpeechArbiter.startNext",
  )(function* (session) {
    const selected = yield* selectNext(session);
    if (selected === undefined) return;
    yield* observeLifecycle({
      kind: "speech.started",
      attempt: selected,
      occurredAt: DateTime.formatIso(yield* DateTime.now),
    });
    const sent = yield* sendSpeech(selected).pipe(
      Effect.timeoutOption(VOICE_TRANSPORT_FEEDBACK_TIMEOUT),
      Effect.exit,
    );
    if (sent._tag === "Success") {
      yield* Effect.sleep(outputTerminalLease(selected)).pipe(
        Effect.andThen(failAndSuspend(selected, "output-timeout")),
        Effect.forkDetach,
      );
      return;
    }
    yield* observeLifecycle({
      kind: "speech.failed",
      attempt: selected,
      occurredAt: DateTime.formatIso(yield* DateTime.now),
      failureReason: "transport-request-failed",
    });
    yield* suspendFailedAttempt(selected);
    yield* Queue.offer(failureQueue, selected);
  });

  const enqueue: VoiceSpeechArbiterShape["enqueue"] = Effect.fn("VoiceSpeechArbiter.enqueue")(
    function* (attempt) {
      const queued = yield* stateMutex.withPermits(1)(
        Ref.modify(statesRef, (states) => {
          const key = sessionKey(attempt.session);
          const current = stateFor(states, attempt.session);
          if (
            (attempt.source === "ambient" || attempt.source === "commentary") &&
            current.active?.attempt.source === attempt.source &&
            sameSemanticText(current.active.attempt.requestedText, attempt.requestedText)
          ) {
            return [
              { accepted: false, superseded: [], queuedAttempt: undefined } as const,
              states,
            ] as const;
          }
          const next = new Map(states);
          if (
            attempt.source === "authored" ||
            attempt.source === "controller" ||
            attempt.source === "catch-up"
          ) {
            const superseded = [
              ...current.commentaryQueue,
              ...(attempt.terminal === true
                ? current.authoredQueue.filter((queued) => queued.source === "catch-up")
                : []),
            ];
            next.set(key, {
              ...current,
              authoredQueue: [
                ...current.authoredQueue.filter(
                  (queued) => attempt.terminal !== true || queued.source !== "catch-up",
                ),
                attempt,
              ],
              commentaryQueue: [],
              pendingAmbient: null,
            });
            return [{ accepted: true, superseded, queuedAttempt: attempt } as const, next] as const;
          } else if (attempt.source === "commentary") {
            const sameGroup = current.commentaryQueue.filter(
              (candidate) => attempt.groupId !== undefined && candidate.groupId === attempt.groupId,
            );
            const duplicate = sameGroup.some((candidate) =>
              sameSemanticText(candidate.requestedText, attempt.requestedText),
            );
            if (duplicate)
              return [
                { accepted: false, superseded: [], queuedAttempt: undefined } as const,
                states,
              ] as const;
            const superseded = [
              ...current.commentaryQueue,
              ...(attempt.terminal === true
                ? current.authoredQueue.filter((queued) => queued.source === "catch-up")
                : []),
            ];
            const compacted: VoiceSpeechAttempt = {
              ...attempt,
              requestedText: compactSpeechText([
                ...sameGroup.map((candidate) => candidate.requestedText),
                attempt.requestedText,
              ]),
            };
            next.set(key, {
              ...current,
              authoredQueue: current.authoredQueue.filter(
                (queued) => attempt.terminal !== true || queued.source !== "catch-up",
              ),
              commentaryQueue: [compacted],
              pendingAmbient: null,
            });
            return [
              { accepted: true, superseded, queuedAttempt: compacted } as const,
              next,
            ] as const;
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
          return [
            { accepted: true, superseded: [], queuedAttempt: attempt } as const,
            next,
          ] as const;
        }),
      );
      if (!queued.accepted || queued.queuedAttempt === undefined) return false;
      const occurredAt = attempt.requestedAt;
      yield* Effect.forEach(
        queued.superseded,
        (superseded) =>
          observeLifecycle({
            kind: "speech.interrupted",
            attempt: superseded,
            occurredAt,
          }),
        { discard: true },
      );
      yield* observeLifecycle({
        kind: "speech.queued",
        attempt: queued.queuedAttempt,
        occurredAt,
      });
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
        next.set(sessionKey(session), {
          ...current,
          providerBusy: true,
        });
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
    if (completion !== undefined) {
      yield* observeLifecycle({
        kind: "speech.completed",
        attempt: completion,
        occurredAt: completion.completedAt,
        deliveredText: completion.deliveredText,
      });
    }
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
    if (observed.completion !== undefined) {
      yield* observeLifecycle({
        kind: "speech.completed",
        attempt: observed.completion,
        occurredAt: observed.completion.completedAt,
        deliveredText: observed.completion.deliveredText,
      });
    }
    if (input.outputDone) yield* startNext(input.session);
    return observed;
  });

  const observeUserSpeech: VoiceSpeechArbiterShape["observeUserSpeech"] = Effect.fn(
    "VoiceSpeechArbiter.observeUserSpeech",
  )(function* (session) {
    const interrupted = yield* stateMutex.withPermits(1)(
      Ref.modify(statesRef, (states) => {
        const current = stateFor(states, session);
        const next = new Map(states);
        next.set(sessionKey(session), {
          ...current,
          providerBusy: true,
          active: current.active === null ? null : { ...current.active, interrupted: true },
          authoredQueue: current.authoredQueue.filter((attempt) => attempt.source !== "catch-up"),
          commentaryQueue: [],
          pendingAmbient: null,
        });
        return [current.active?.attempt, next] as const;
      }),
    );
    if (interrupted !== undefined) {
      yield* observeLifecycle({
        kind: "speech.interrupted",
        attempt: interrupted,
        occurredAt: DateTime.formatIso(yield* DateTime.now),
      });
    }
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
    takeFailure: Queue.take(failureQueue),
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
    const callEvents = yield* VoiceCallEventRepository;
    return yield* makeVoiceSpeechArbiter(
      (attempt) =>
        runtime.appendTransportSpeech({
          transportThreadId: attempt.session.fence.transportThreadId,
          generation: attempt.session.fence.generation,
          text: attempt.requestedText,
        }),
      (event) => {
        const owner = event.attempt.session.fence.owner;
        if (owner?.kind !== "thread-call") return Effect.void;
        return callEvents
          .append({
            environmentId: event.attempt.session.environmentId,
            threadId: owner.threadId,
            transportSessionId: event.attempt.session.transportSessionId,
            generation: event.attempt.session.fence.generation,
            kind: event.kind,
            correlationId: event.attempt.attemptId,
            threadSnapshotSequence: null,
            payload: {
              source: event.attempt.source,
              requestedText: event.attempt.requestedText,
              ...(event.attempt.groupId === undefined ? {} : { groupId: event.attempt.groupId }),
              ...(event.attempt.terminal === undefined ? {} : { terminal: event.attempt.terminal }),
              ...(event.deliveredText === undefined ? {} : { deliveredText: event.deliveredText }),
              ...(event.failureReason === undefined ? {} : { failureReason: event.failureReason }),
            },
            occurredAt: event.occurredAt,
          })
          .pipe(Effect.ignore);
      },
    );
  }),
);
