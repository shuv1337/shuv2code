import {
  CommandId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderEffectOutcomeState,
} from "@shuv2code/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { VoiceControllerMutationRepositoryLive } from "../persistence/Layers/VoiceControllerMutations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { VoiceControllerMutationRepository } from "../persistence/Services/VoiceControllerMutations.ts";
import {
  classifyAuthoritativeVoiceMutation,
  reconcileVoiceMutationOutcomes,
} from "./VoiceMutationOutcomeReconciler.ts";

const layer = it.layer(
  VoiceControllerMutationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const now = "2026-07-30T00:00:00.000Z";
const targetThreadId = ThreadId.make("target-thread-1");
type ProviderOutcomeEvent = Extract<
  OrchestrationEvent,
  { readonly type: "thread.provider-effect-outcome-set" }
>;

function outcomeEvent(
  sequence: number,
  operationId: string,
  state: ProviderEffectOutcomeState,
  sanitizedCode: string,
): ProviderOutcomeEvent {
  const updatedAt = `2026-07-30T00:00:${String(sequence).padStart(2, "0")}.000Z`;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type: "thread.provider-effect-outcome-set",
    aggregateKind: "thread",
    aggregateId: targetThreadId,
    occurredAt: updatedAt,
    commandId: CommandId.make(`provider:outcome:${sequence}`),
    causationEventId: null,
    correlationId: null,
    payload: {
      threadId: targetThreadId,
      outcome: {
        operationId,
        operation: "steer",
        state,
        threadId: targetThreadId,
        expectedTurnId: TurnId.make("target-turn-1"),
        actualTurnId: TurnId.make("target-turn-1"),
        sanitizedCode,
        updatedAt,
      },
      createdAt: updatedAt,
    },
    metadata: {},
  };
}

const seedMutationRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_controller_mutations`;
  yield* sql`DELETE FROM voice_controller_actions`;
  yield* sql`DELETE FROM voice_transport_sessions`;
  yield* sql`DELETE FROM voice_controller_bindings`;
  yield* sql`
    INSERT INTO voice_controller_bindings (
      environment_id,
      controller_thread_id,
      host_project_id,
      provider_instance_id,
      authorized_runtime_ceiling,
      binding_generation,
      control_epoch,
      state,
      created_at,
      updated_at
    )
    VALUES (
      'environment-1',
      'controller-1',
      'project-1',
      'codex',
      'approval-required',
      1,
      0,
      'active',
      ${now},
      ${now}
    )
  `;
  yield* sql`
    INSERT INTO voice_transport_sessions (
      transport_session_id,
      environment_id,
      controller_thread_id,
      owner_kind,
      owner_id,
      provider_anchor_thread_id,
      transport_thread_id,
      runtime_instance_id,
      generation,
      realtime_session_id,
      state,
      created_at,
      updated_at
    )
    VALUES (
      'transport-1',
      'environment-1',
      'controller-1',
      -- Migration 049 made ownership explicit and backfilled every pre-existing
      -- row as a controller session owned by its controller thread, with no
      -- provider anchor. This fixture is exactly such a session, so it carries
      -- the same triple the migration would have written for it.
      'controller',
      'controller-1',
      NULL,
      'transport-thread-1',
      'transport-runtime-1',
      1,
      'realtime-1',
      'active',
      ${now},
      ${now}
    )
  `;

  for (const [index, operationId, dispatchState] of [
    [1, "operation-main", "dispatched"],
    [2, "operation-unmatched", "dispatched"],
    [3, "operation-indeterminate", "indeterminate"],
    [4, "operation-claimed", "claimed"],
  ] as const) {
    yield* sql`
      INSERT INTO voice_controller_actions (
        voice_action_id,
        environment_id,
        controller_thread_id,
        transport_session_id,
        transport_runtime_instance_id,
        transport_generation,
        handoff_id,
        handoff_item_id,
        client_user_message_id,
        controller_runtime_instance_id,
        controller_provider_session_id,
        controller_provider_turn_id,
        claimed_mutation_key,
        state,
        created_at,
        controller_turn_bound_at
      )
      VALUES (
        ${`action-${index}`},
        'environment-1',
        'controller-1',
        'transport-1',
        'transport-runtime-1',
        1,
        ${`handoff-${index}`},
        ${`item-${index}`},
        ${`action-${index}`},
        'controller-runtime-1',
        'controller-provider-session-1',
        ${`controller-turn-${index}`},
        ${`mutation-${index}`},
        'active',
        ${now},
        ${now}
      )
    `;
    yield* sql`
      INSERT INTO voice_controller_mutations (
        voice_action_id,
        mutation_key,
        tool_name,
        semantic_slot,
        canonical_request_hash,
        operation_id,
        provider_creation_id,
        binding_generation,
        control_epoch,
        dispatch_state,
        claim_owner,
        claim_expires_at,
        claimed_at,
        dispatch_started_at,
        created_at,
        updated_at
      )
      VALUES (
        ${`action-${index}`},
        ${`mutation-${index}`},
        'thread_send',
        ${`send:target-${index}`},
        ${`hash-${index}`},
        ${operationId},
        NULL,
        1,
        0,
        ${dispatchState},
        ${dispatchState === "claimed" ? "worker-1" : null},
        ${dispatchState === "claimed" ? "2026-07-30T00:01:00.000Z" : null},
        ${dispatchState === "claimed" ? now : null},
        ${dispatchState === "dispatched" || dispatchState === "indeterminate" ? now : null},
        ${now},
        ${now}
      )
    `;
  }
});

const seedCrashBoundaryMutations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [index, operationId, toolName, semanticSlot] of [
    [5, "voice:action-5:send-start", "thread_send", "send:target-thread-1"],
    [6, "voice:action-6:send-steer", "thread_send", "send:target-thread-1"],
    [7, "voice:action-7:interrupt", "thread_interrupt", "interrupt:target-thread-1:turn-interrupt"],
  ] as const) {
    yield* sql`
      INSERT INTO voice_controller_actions (
        voice_action_id,
        environment_id,
        controller_thread_id,
        transport_session_id,
        transport_runtime_instance_id,
        transport_generation,
        handoff_id,
        handoff_item_id,
        client_user_message_id,
        controller_runtime_instance_id,
        controller_provider_session_id,
        controller_provider_turn_id,
        claimed_mutation_key,
        state,
        created_at,
        controller_turn_bound_at
      )
      VALUES (
        ${`action-${index}`},
        'environment-1',
        'controller-1',
        'transport-1',
        'transport-runtime-1',
        1,
        ${`handoff-${index}`},
        ${`item-${index}`},
        ${`action-${index}`},
        'controller-runtime-1',
        'controller-provider-session-1',
        ${`controller-turn-${index}`},
        ${`mutation-${index}`},
        'active',
        ${now},
        ${now}
      )
    `;
    yield* sql`
      INSERT INTO voice_controller_mutations (
        voice_action_id,
        mutation_key,
        tool_name,
        semantic_slot,
        canonical_request_hash,
        operation_id,
        provider_creation_id,
        binding_generation,
        control_epoch,
        dispatch_state,
        dispatch_started_at,
        created_at,
        updated_at
      )
      VALUES (
        ${`action-${index}`},
        ${`mutation-${index}`},
        ${toolName},
        ${semanticSlot},
        ${`hash-${index}`},
        ${operationId},
        NULL,
        1,
        0,
        'dispatched',
        ${now},
        ${now},
        ${now}
      )
    `;
  }
});

layer("VoiceMutationOutcomeReconciler", (it) => {
  it.effect(
    "repairs latest persisted terminal outcomes without replaying or resolving unmatched work",
    () =>
      Effect.gen(function* () {
        yield* seedMutationRows;
        const mutations = yield* VoiceControllerMutationRepository;
        const events = [
          outcomeEvent(1, "unrelated-operation", "confirmed", "unrelated"),
          outcomeEvent(2, "operation-main", "pending", "pending"),
          outcomeEvent(3, "operation-main", "failed", "early-failure"),
          outcomeEvent(4, "unrelated-operation-2", "stale", "unrelated"),
          outcomeEvent(5, "operation-indeterminate", "stale", "provider-stale"),
          outcomeEvent(6, "operation-main", "confirmed", "provider-confirmed"),
          outcomeEvent(7, "operation-claimed", "confirmed", "provider-confirmed-after-crash"),
          outcomeEvent(8, "unrelated-operation-3", "failed", "unrelated"),
          outcomeEvent(9, "operation-unmatched", "confirmed", "past-upper-bound"),
        ];
        const readCursors: Array<number> = [];
        const engine = {
          latestSequence: Effect.succeed(8),
          readEvents: (cursor: number, limit = 1_000) => {
            readCursors.push(cursor);
            return Stream.fromIterable(
              events.filter((event) => event.sequence > cursor).slice(0, limit),
            );
          },
        };

        const result = yield* reconcileVoiceMutationOutcomes({
          engine,
          mutations,
          includeClaimed: true,
          pageSize: 2,
        });
        assert.deepStrictEqual(result, {
          recoverableCount: 4,
          eligibleCount: 4,
          matchedCount: 3,
          appliedCount: 3,
          scannedEvents: 8,
          upperBoundSequence: 8,
          authoritativeReadCount: 0,
          authoritativeAppliedCount: 0,
        });
        assert.deepStrictEqual(readCursors, [0, 2, 4, 6]);

        const main = Option.getOrThrow(yield* mutations.getByOperationId("operation-main"));
        assert.strictEqual(main.dispatchState, "confirmed");
        assert.strictEqual(main.sanitizedOutcome, "provider-confirmed");
        assert.strictEqual(main.providerAcknowledgedAt, "2026-07-30T00:00:06.000Z");

        const refined = Option.getOrThrow(
          yield* mutations.getByOperationId("operation-indeterminate"),
        );
        assert.strictEqual(refined.dispatchState, "stale");
        assert.strictEqual(refined.sanitizedOutcome, "provider-stale");

        assert.strictEqual(
          Option.getOrThrow(yield* mutations.getByOperationId("operation-unmatched")).dispatchState,
          "dispatched",
        );
        const claimed = Option.getOrThrow(yield* mutations.getByOperationId("operation-claimed"));
        assert.strictEqual(claimed.dispatchState, "confirmed");
        assert.strictEqual(claimed.sanitizedOutcome, "provider-confirmed-after-crash");

        const secondPass = yield* reconcileVoiceMutationOutcomes({
          engine,
          mutations,
          pageSize: 2,
        });
        assert.strictEqual(secondPass.eligibleCount, 1);
        assert.strictEqual(secondPass.matchedCount, 0);
        assert.strictEqual(secondPass.appliedCount, 0);
        assert.strictEqual(
          Option.getOrThrow(yield* mutations.getByOperationId("operation-unmatched")).dispatchState,
          "dispatched",
        );
      }),
  );

  it.effect("fences a crash-boundary claim when no durable provider evidence exists", () =>
    Effect.gen(function* () {
      yield* seedMutationRows;
      const mutations = yield* VoiceControllerMutationRepository;
      const engine = {
        latestSequence: Effect.succeed(0),
        readEvents: () => Stream.empty,
      };
      const runtimeResult = yield* reconcileVoiceMutationOutcomes({
        engine,
        mutations,
      });
      assert.strictEqual(runtimeResult.eligibleCount, 3);
      assert.strictEqual(
        Option.getOrThrow(yield* mutations.getByOperationId("operation-claimed")).dispatchState,
        "claimed",
      );

      const result = yield* reconcileVoiceMutationOutcomes({
        engine,
        mutations,
        includeClaimed: true,
      });

      assert.strictEqual(result.eligibleCount, 4);
      assert.strictEqual(result.scannedEvents, 0);
      assert.strictEqual(result.authoritativeAppliedCount, 1);
      const claimed = Option.getOrThrow(yield* mutations.getByOperationId("operation-claimed"));
      assert.strictEqual(claimed.dispatchState, "indeterminate");
      assert.strictEqual(claimed.sanitizedOutcome, "provider_reconciliation_evidence_unavailable");
    }),
  );

  it.effect(
    "reconciles post-call crashes from provider history without replaying any external call",
    () =>
      Effect.gen(function* () {
        yield* seedMutationRows;
        yield* seedCrashBoundaryMutations;
        const mutations = yield* VoiceControllerMutationRepository;
        const pending = (
          sequence: number,
          operationId: string,
          operation: "start" | "steer" | "interrupt",
          expectedTurnId: string | null,
        ): OrchestrationEvent => {
          const event = outcomeEvent(sequence, operationId, "pending", "dispatch_pending");
          return {
            ...event,
            payload: {
              ...event.payload,
              outcome: {
                ...event.payload.outcome,
                operation,
                expectedTurnId: expectedTurnId === null ? null : TurnId.make(expectedTurnId),
              },
            },
          };
        };
        const events = [
          pending(1, "voice:action-5:send-start", "start", null),
          pending(2, "voice:action-6:send-steer", "steer", "turn-steer"),
          pending(3, "voice:action-7:interrupt", "interrupt", "turn-interrupt"),
        ];
        let providerReads = 0;
        const result = yield* reconcileVoiceMutationOutcomes({
          engine: {
            latestSequence: Effect.succeed(3),
            readEvents: (cursor: number, limit = 1_000) =>
              Stream.fromIterable(
                events.filter((event) => event.sequence > cursor).slice(0, limit),
              ),
          },
          mutations,
          includeClaimed: true,
          readThread: () => {
            providerReads += 1;
            return Effect.succeed({
              threadId: targetThreadId,
              turns: [
                {
                  id: TurnId.make("turn-start"),
                  status: "inProgress" as const,
                  itemsView: "full" as const,
                  items: [
                    {
                      type: "userMessage",
                      id: "provider-message-start",
                      clientId: "voice:action-5:send-start:message",
                      content: [],
                    },
                  ],
                },
                {
                  id: TurnId.make("turn-steer"),
                  status: "completed" as const,
                  itemsView: "full" as const,
                  items: [],
                },
                {
                  id: TurnId.make("turn-interrupt"),
                  status: "interrupted" as const,
                  itemsView: "full" as const,
                  items: [],
                },
              ],
            });
          },
        });

        assert.strictEqual(providerReads, 3);
        assert.strictEqual(result.authoritativeReadCount, 3);
        assert.strictEqual(result.authoritativeAppliedCount, 7);
        assert.strictEqual(
          Option.getOrThrow(yield* mutations.getByOperationId("voice:action-5:send-start"))
            .dispatchState,
          "confirmed",
        );
        assert.strictEqual(
          Option.getOrThrow(yield* mutations.getByOperationId("voice:action-6:send-steer"))
            .dispatchState,
          "stale",
        );
        const interrupt = Option.getOrThrow(
          yield* mutations.getByOperationId("voice:action-7:interrupt"),
        );
        assert.strictEqual(interrupt.dispatchState, "indeterminate");
        assert.strictEqual(interrupt.sanitizedOutcome, "provider_interrupt_identity_unavailable");
      }),
  );

  it.effect("uses exact provider message ids as the send/steer crash witness", () =>
    Effect.sync(() => {
      const startOperationId = "voice:action-start:send-start";
      assert.deepStrictEqual(
        classifyAuthoritativeVoiceMutation({
          mutation: {
            operationId: startOperationId,
            toolName: "thread_send",
            semanticSlot: "send:target-thread-1",
          },
          snapshot: {
            threadId: targetThreadId,
            turns: [
              {
                id: TurnId.make("started-turn"),
                status: "inProgress",
                itemsView: "full",
                items: [
                  {
                    type: "userMessage",
                    id: "provider-message-1",
                    clientId: `${startOperationId}:message`,
                    content: [],
                  },
                ],
              },
            ],
          },
        }),
        {
          outcome: "confirmed",
          sanitizedCode: "provider_message_id_observed",
        },
      );

      const steerOperationId = "voice:action-steer:send-steer";
      const persistedOutcome = {
        operationId: steerOperationId,
        operation: "steer" as const,
        state: "pending" as const,
        threadId: targetThreadId,
        expectedTurnId: TurnId.make("expected-turn"),
        actualTurnId: null,
        sanitizedCode: "dispatch_pending",
        updatedAt: now,
      };
      assert.deepStrictEqual(
        classifyAuthoritativeVoiceMutation({
          mutation: {
            operationId: steerOperationId,
            toolName: "thread_send",
            semanticSlot: "send:target-thread-1",
          },
          persistedOutcome,
          snapshot: {
            threadId: targetThreadId,
            turns: [
              {
                id: TurnId.make("expected-turn"),
                status: "completed",
                itemsView: "full",
                items: [
                  {
                    type: "userMessage",
                    id: "provider-message-2",
                    clientId: `${steerOperationId}:message`,
                    content: [],
                  },
                ],
              },
            ],
          },
        }),
        {
          outcome: "confirmed",
          sanitizedCode: "provider_message_id_observed",
        },
      );
    }),
  );

  it.effect("proves stale steer only from a full terminal turn and otherwise fails closed", () =>
    Effect.sync(() => {
      const operationId = "voice:action-steer:send-steer";
      const persistedOutcome = {
        operationId,
        operation: "steer" as const,
        state: "pending" as const,
        threadId: targetThreadId,
        expectedTurnId: TurnId.make("expected-turn"),
        actualTurnId: null,
        sanitizedCode: "dispatch_pending",
        updatedAt: now,
      };
      const mutation = {
        operationId,
        toolName: "thread_send",
        semanticSlot: "send:target-thread-1",
      };

      assert.deepStrictEqual(
        classifyAuthoritativeVoiceMutation({
          mutation,
          persistedOutcome,
          snapshot: {
            threadId: targetThreadId,
            turns: [
              {
                id: TurnId.make("expected-turn"),
                status: "completed",
                itemsView: "full",
                items: [],
              },
            ],
          },
        }),
        {
          outcome: "stale",
          sanitizedCode: "provider_steer_target_terminal_without_message",
        },
      );
      assert.deepStrictEqual(
        classifyAuthoritativeVoiceMutation({
          mutation,
          persistedOutcome,
          snapshot: {
            threadId: targetThreadId,
            turns: [
              {
                id: TurnId.make("expected-turn"),
                status: "completed",
                itemsView: "summary",
                items: [],
              },
            ],
          },
        }),
        {
          outcome: "indeterminate",
          sanitizedCode: "provider_steer_outcome_unproven",
        },
      );
    }),
  );

  it.effect(
    "never guesses interrupt success because the public interrupt protocol has no operation id",
    () =>
      Effect.sync(() => {
        const operationId = "voice:action-interrupt:interrupt";
        const mutation = {
          operationId,
          toolName: "thread_interrupt",
          semanticSlot: "interrupt:target-thread-1:expected-turn",
        };
        const persistedOutcome = {
          operationId,
          operation: "interrupt" as const,
          state: "pending" as const,
          threadId: targetThreadId,
          expectedTurnId: TurnId.make("expected-turn"),
          actualTurnId: null,
          sanitizedCode: "dispatch_pending",
          updatedAt: now,
        };
        assert.deepStrictEqual(
          classifyAuthoritativeVoiceMutation({
            mutation,
            persistedOutcome,
            snapshot: {
              threadId: targetThreadId,
              turns: [
                {
                  id: TurnId.make("expected-turn"),
                  status: "interrupted",
                  itemsView: "full",
                  items: [],
                },
              ],
            },
          }),
          {
            outcome: "indeterminate",
            sanitizedCode: "provider_interrupt_identity_unavailable",
          },
        );
        assert.deepStrictEqual(
          classifyAuthoritativeVoiceMutation({
            mutation,
            persistedOutcome,
            snapshot: {
              threadId: targetThreadId,
              turns: [
                {
                  id: TurnId.make("expected-turn"),
                  status: "completed",
                  itemsView: "full",
                  items: [],
                },
              ],
            },
          }),
          {
            outcome: "stale",
            sanitizedCode: "provider_interrupt_target_completed",
          },
        );
      }),
  );
});
