import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceControllerMutationRepository,
  type VoiceControllerMutationRepositoryShape,
} from "../Services/VoiceControllerMutations.ts";
import { VoiceControllerMutation } from "../VoiceControlModels.ts";

const VoiceActionIdRequest = Schema.Struct({
  voiceActionId: Schema.String,
});
const OperationIdRequest = Schema.Struct({
  operationId: Schema.String,
});

const VoiceActionMutationClaimState = Schema.Struct({
  state: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  controllerProviderTurnId: Schema.NullOr(Schema.String),
  claimedMutationKey: Schema.NullOr(Schema.String),
});

const mutationColumns = `
  voice_action_id AS "voiceActionId",
  mutation_key AS "mutationKey",
  tool_name AS "toolName",
  semantic_slot AS "semanticSlot",
  canonical_request_hash AS "canonicalRequestHash",
  operation_id AS "operationId",
  provider_creation_id AS "providerCreationId",
  binding_generation AS "bindingGeneration",
  control_epoch AS "controlEpoch",
  dispatch_state AS "dispatchState",
  claim_owner AS "claimOwner",
  claim_expires_at AS "claimExpiresAt",
  claimed_at AS "claimedAt",
  dispatch_started_at AS "dispatchStartedAt",
  provider_acknowledged_at AS "providerAcknowledgedAt",
  outcome_at AS "outcomeAt",
  sanitized_outcome AS "sanitizedOutcome",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const makeVoiceControllerMutationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByActionId = SqlSchema.findOneOption({
    Request: VoiceActionIdRequest,
    Result: VoiceControllerMutation,
    execute: ({ voiceActionId }) =>
      sql.unsafe(
        `SELECT ${mutationColumns}
         FROM voice_controller_mutations
         WHERE voice_action_id = ?`,
        [voiceActionId],
      ),
  });

  const findByOperationId = SqlSchema.findOneOption({
    Request: OperationIdRequest,
    Result: VoiceControllerMutation,
    execute: ({ operationId }) =>
      sql.unsafe(
        `SELECT ${mutationColumns}
         FROM voice_controller_mutations
         WHERE operation_id = ?
         LIMIT 1`,
        [operationId],
      ),
  });

  const findActionClaimState = SqlSchema.findOneOption({
    Request: VoiceActionIdRequest,
    Result: VoiceActionMutationClaimState,
    execute: ({ voiceActionId }) =>
      sql`
        SELECT
          state,
          closed_at AS "closedAt",
          controller_provider_turn_id AS "controllerProviderTurnId",
          claimed_mutation_key AS "claimedMutationKey"
        FROM voice_controller_actions
        WHERE voice_action_id = ${voiceActionId}
      `,
  });

  const claimOrReplay: VoiceControllerMutationRepositoryShape["claimOrReplay"] = (input) => {
    const validCreationIdentity =
      input.toolName === "thread_create"
        ? input.providerCreationId !== null
        : input.providerCreationId === null;
    if (!validCreationIdentity) {
      return Effect.succeed({ _tag: "conflict", mutation: null });
    }

    return sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findByActionId({ voiceActionId: input.voiceActionId });
          if (Option.isSome(existing)) {
            const mutation = existing.value;
            const exact =
              mutation.mutationKey === input.mutationKey &&
              mutation.toolName === input.toolName &&
              mutation.semanticSlot === input.semanticSlot &&
              mutation.canonicalRequestHash === input.canonicalRequestHash &&
              mutation.operationId === input.operationId &&
              mutation.providerCreationId === input.providerCreationId &&
              mutation.bindingGeneration === input.bindingGeneration &&
              mutation.controlEpoch === input.controlEpoch;
            return exact
              ? ({ _tag: "replay", mutation } as const)
              : ({ _tag: "conflict", mutation } as const);
          }

          const action = yield* findActionClaimState({ voiceActionId: input.voiceActionId });
          if (
            Option.isNone(action) ||
            action.value.state !== "active" ||
            action.value.closedAt !== null ||
            action.value.controllerProviderTurnId === null
          ) {
            return { _tag: "action_unavailable" } as const;
          }
          if (
            action.value.claimedMutationKey !== null &&
            action.value.claimedMutationKey !== input.mutationKey
          ) {
            return { _tag: "conflict", mutation: null } as const;
          }

          const claimed = yield* sql`
            UPDATE voice_controller_actions
            SET claimed_mutation_key = ${input.mutationKey}
            WHERE voice_action_id = ${input.voiceActionId}
              AND state = 'active'
              AND closed_at IS NULL
              AND (
                claimed_mutation_key IS NULL
                OR claimed_mutation_key = ${input.mutationKey}
              )
            RETURNING voice_action_id
          `;
          if (claimed.length === 0) {
            return { _tag: "conflict", mutation: null } as const;
          }

          const inserted = yield* sql`
            INSERT OR IGNORE INTO voice_controller_mutations (
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
              provider_acknowledged_at,
              outcome_at,
              sanitized_outcome,
              created_at,
              updated_at
            )
            VALUES (
              ${input.voiceActionId},
              ${input.mutationKey},
              ${input.toolName},
              ${input.semanticSlot},
              ${input.canonicalRequestHash},
              ${input.operationId},
              ${input.providerCreationId},
              ${input.bindingGeneration},
              ${input.controlEpoch},
              'never_dispatched',
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              ${input.createdAt},
              ${input.createdAt}
            )
            RETURNING voice_action_id
          `;

          const mutation = yield* findByActionId({ voiceActionId: input.voiceActionId });
          if (Option.isNone(mutation)) {
            return { _tag: "conflict", mutation: null } as const;
          }
          return inserted.length > 0
            ? ({ _tag: "claimed", mutation: mutation.value } as const)
            : ({ _tag: "replay", mutation: mutation.value } as const);
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceControllerMutationRepository.claimOrReplay:transaction"),
        ),
      );
  };

  const getByActionId: VoiceControllerMutationRepositoryShape["getByActionId"] = (voiceActionId) =>
    findByActionId({ voiceActionId }).pipe(
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerMutationRepository.getByActionId:query"),
      ),
    );

  const getByOperationId: VoiceControllerMutationRepositoryShape["getByOperationId"] = (
    operationId,
  ) =>
    findByOperationId({ operationId }).pipe(
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerMutationRepository.getByOperationId:query"),
      ),
    );

  const claimDispatch: VoiceControllerMutationRepositoryShape["claimDispatch"] = (input) =>
    sql`
      UPDATE voice_controller_mutations
      SET
        dispatch_state = 'claimed',
        claim_owner = ${input.claimOwner},
        claim_expires_at = ${input.claimExpiresAt},
        claimed_at = ${input.claimedAt},
        updated_at = ${input.claimedAt}
      WHERE voice_action_id = ${input.voiceActionId}
        AND (
          dispatch_state = 'never_dispatched'
          OR (
            dispatch_state = 'claimed'
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ${input.claimedAt}
          )
        )
        AND binding_generation = ${input.expectedBindingGeneration}
        AND control_epoch = ${input.expectedControlEpoch}
        AND EXISTS (
          SELECT 1
          FROM voice_controller_actions
          INNER JOIN voice_controller_bindings
            ON voice_controller_bindings.environment_id =
              voice_controller_actions.environment_id
            AND voice_controller_bindings.controller_thread_id =
              voice_controller_actions.controller_thread_id
          WHERE voice_controller_actions.voice_action_id =
            voice_controller_mutations.voice_action_id
            AND voice_controller_actions.state = 'active'
            AND voice_controller_actions.closed_at IS NULL
            AND voice_controller_bindings.state = 'active'
            AND voice_controller_bindings.binding_generation =
              ${input.expectedBindingGeneration}
            AND voice_controller_bindings.control_epoch =
              ${input.expectedControlEpoch}
        )
      RETURNING voice_action_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerMutationRepository.claimDispatch:query"),
      ),
    );

  const releaseClaim: VoiceControllerMutationRepositoryShape["releaseClaim"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // A control-disable transition increments the durable binding epoch
          // before sweeping never-dispatched work. If this mutation was claimed
          // during that sweep, releasing it must preserve the fence rather than
          // recreating replayable work after control is re-enabled.
          const fenced = yield* sql`
          UPDATE voice_controller_mutations
          SET
            dispatch_state = ${
              input.mayHavePersistedIntents ? "indeterminate" : "cancelled_by_policy"
            },
            claim_owner = NULL,
            claim_expires_at = NULL,
            claimed_at = NULL,
            outcome_at = ${input.updatedAt},
            sanitized_outcome = ${
              input.mayHavePersistedIntents
                ? "voice_thread_control_disabled_during_dispatch"
                : "voice_thread_control_disabled"
            },
            updated_at = ${input.updatedAt}
          WHERE voice_action_id = ${input.voiceActionId}
            AND dispatch_state = 'claimed'
            AND claim_owner = ${input.claimOwner}
            AND NOT EXISTS (
              SELECT 1
              FROM voice_controller_actions
              INNER JOIN voice_controller_bindings
                ON voice_controller_bindings.environment_id =
                  voice_controller_actions.environment_id
                AND voice_controller_bindings.controller_thread_id =
                  voice_controller_actions.controller_thread_id
              WHERE voice_controller_actions.voice_action_id =
                voice_controller_mutations.voice_action_id
                AND voice_controller_bindings.binding_generation =
                  voice_controller_mutations.binding_generation
                AND voice_controller_bindings.control_epoch =
                  voice_controller_mutations.control_epoch
            )
          RETURNING voice_action_id
        `;
          if (fenced.length === 1) return true;

          const released = yield* sql`
          UPDATE voice_controller_mutations
          SET
            dispatch_state = 'never_dispatched',
            claim_owner = NULL,
            claim_expires_at = NULL,
            claimed_at = NULL,
            updated_at = ${input.updatedAt}
          WHERE voice_action_id = ${input.voiceActionId}
            AND dispatch_state = 'claimed'
            AND claim_owner = ${input.claimOwner}
          RETURNING voice_action_id
        `;
          return released.length === 1;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceControllerMutationRepository.releaseClaim:transaction"),
        ),
      );

  const markDispatched: VoiceControllerMutationRepositoryShape["markDispatched"] = (input) =>
    sql`
      UPDATE voice_controller_mutations
      SET
        dispatch_state = 'dispatched',
        dispatch_started_at = ${input.dispatchedAt},
        updated_at = ${input.dispatchedAt}
      WHERE voice_action_id = ${input.voiceActionId}
        AND dispatch_state = 'claimed'
        AND claim_owner = ${input.claimOwner}
        AND claim_expires_at > ${input.dispatchedAt}
      RETURNING voice_action_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerMutationRepository.markDispatched:query"),
      ),
    );

  const recordOutcome: VoiceControllerMutationRepositoryShape["recordOutcome"] = (input) =>
    sql`
      UPDATE voice_controller_mutations
      SET
        dispatch_state = ${input.outcome},
        provider_acknowledged_at = ${input.providerAcknowledgedAt},
        outcome_at = ${input.outcomeAt},
        sanitized_outcome = ${input.sanitizedOutcome},
        updated_at = ${input.outcomeAt}
      WHERE voice_action_id = ${input.voiceActionId}
        AND (
          dispatch_state = 'dispatched'
          OR dispatch_state = 'indeterminate'
          OR (
            dispatch_state = ${input.outcome}
            AND outcome_at = ${input.outcomeAt}
            AND sanitized_outcome IS ${input.sanitizedOutcome}
          )
        )
      RETURNING voice_action_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerMutationRepository.recordOutcome:query"),
      ),
    );

  const reconcilePersistedOutcome: VoiceControllerMutationRepositoryShape["reconcilePersistedOutcome"] =
    (input) =>
      sql`
        UPDATE voice_controller_mutations
        SET
          dispatch_state = ${input.outcome},
          provider_acknowledged_at = ${input.providerAcknowledgedAt},
          outcome_at = ${input.outcomeAt},
          sanitized_outcome = ${input.sanitizedOutcome},
          updated_at = ${input.outcomeAt}
        WHERE operation_id = ${input.operationId}
          AND dispatch_state IN ('claimed', 'dispatched', 'indeterminate')
        RETURNING voice_action_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          toPersistenceSqlError(
            "VoiceControllerMutationRepository.reconcilePersistedOutcome:query",
          ),
        ),
      );

  const cancelNeverDispatchedByPolicy: VoiceControllerMutationRepositoryShape["cancelNeverDispatchedByPolicy"] =
    (input) =>
      sql`
        UPDATE voice_controller_mutations
        SET
          dispatch_state = 'cancelled_by_policy',
          outcome_at = ${input.cancelledAt},
          sanitized_outcome = ${input.sanitizedOutcome},
          updated_at = ${input.cancelledAt}
        WHERE voice_action_id = ${input.voiceActionId}
          AND (
            dispatch_state = 'never_dispatched'
            OR (
              dispatch_state = 'cancelled_by_policy'
              AND outcome_at = ${input.cancelledAt}
              AND sanitized_outcome IS ${input.sanitizedOutcome}
            )
          )
        RETURNING voice_action_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          toPersistenceSqlError(
            "VoiceControllerMutationRepository.cancelNeverDispatchedByPolicy:query",
          ),
        ),
      );

  const cancelAllNeverDispatchedByPolicy: VoiceControllerMutationRepositoryShape["cancelAllNeverDispatchedByPolicy"] =
    (input) =>
      sql`
        UPDATE voice_controller_mutations
        SET
          dispatch_state = 'cancelled_by_policy',
          outcome_at = ${input.cancelledAt},
          sanitized_outcome = ${input.sanitizedOutcome},
          updated_at = ${input.cancelledAt}
        WHERE dispatch_state = 'never_dispatched'
          AND control_epoch <= ${input.throughControlEpoch}
          AND EXISTS (
            SELECT 1
            FROM voice_controller_actions
            WHERE voice_controller_actions.voice_action_id =
              voice_controller_mutations.voice_action_id
              AND voice_controller_actions.environment_id = ${input.environmentId}
              AND voice_controller_actions.controller_thread_id =
                ${input.controllerThreadId}
          )
        RETURNING voice_action_id
      `.pipe(
        Effect.map((rows) => rows.length),
        Effect.mapError(
          toPersistenceSqlError(
            "VoiceControllerMutationRepository.cancelAllNeverDispatchedByPolicy:query",
          ),
        ),
      );

  const listRecoverable: VoiceControllerMutationRepositoryShape["listRecoverable"] = () =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: VoiceControllerMutation,
      execute: () =>
        sql.unsafe(
          `SELECT ${mutationColumns}
           FROM voice_controller_mutations
           WHERE dispatch_state IN ('claimed', 'dispatched', 'indeterminate')
           ORDER BY updated_at ASC, voice_action_id ASC`,
        ),
    })(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("VoiceControllerMutationRepository.listRecoverable:query"),
      ),
    );

  return VoiceControllerMutationRepository.of({
    claimOrReplay,
    getByActionId,
    getByOperationId,
    claimDispatch,
    releaseClaim,
    markDispatched,
    recordOutcome,
    reconcilePersistedOutcome,
    cancelNeverDispatchedByPolicy,
    cancelAllNeverDispatchedByPolicy,
    listRecoverable,
  });
});

export const VoiceControllerMutationRepositoryLive = Layer.effect(
  VoiceControllerMutationRepository,
  makeVoiceControllerMutationRepository,
);
