import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceControllerActionRepository,
  type VoiceControllerActionRepositoryShape,
} from "../Services/VoiceControllerActions.ts";
import { VoiceControllerAction } from "../VoiceControlModels.ts";

const VoiceActionIdRequest = Schema.Struct({
  voiceActionId: Schema.String,
});
const HandoffRequest = Schema.Struct({
  transportSessionId: Schema.String,
  handoffId: Schema.String,
  handoffItemId: Schema.String,
});

const actionColumns = `
    voice_action_id AS "voiceActionId",
    environment_id AS "environmentId",
    controller_thread_id AS "controllerThreadId",
    transport_session_id AS "transportSessionId",
    transport_runtime_instance_id AS "transportRuntimeInstanceId",
    transport_generation AS "transportGeneration",
    handoff_id AS "handoffId",
    handoff_item_id AS "handoffItemId",
    client_user_message_id AS "clientUserMessageId",
    controller_runtime_instance_id AS "controllerRuntimeInstanceId",
    controller_provider_session_id AS "controllerProviderSessionId",
    controller_provider_turn_id AS "controllerProviderTurnId",
    claimed_mutation_key AS "claimedMutationKey",
    state,
    created_at AS "createdAt",
    controller_turn_bound_at AS "controllerTurnBoundAt",
    closed_at AS "closedAt"
`;

const makeVoiceControllerActionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findById = SqlSchema.findOneOption({
    Request: VoiceActionIdRequest,
    Result: VoiceControllerAction,
    execute: ({ voiceActionId }) =>
      sql.unsafe(
        `SELECT ${actionColumns}
         FROM voice_controller_actions
         WHERE voice_action_id = ?`,
        [voiceActionId],
      ),
  });

  const findByHandoff = SqlSchema.findOneOption({
    Request: HandoffRequest,
    Result: VoiceControllerAction,
    execute: ({ transportSessionId, handoffId, handoffItemId }) =>
      sql.unsafe(
        `SELECT ${actionColumns}
         FROM voice_controller_actions
         WHERE transport_session_id = ?
           AND handoff_id = ?
           AND handoff_item_id = ?`,
        [transportSessionId, handoffId, handoffItemId],
      ),
  });

  const createOrReplay: VoiceControllerActionRepositoryShape["createOrReplay"] = (input) => {
    if (input.clientUserMessageId !== input.voiceActionId) {
      return Effect.succeed({ _tag: "conflict", action: null });
    }
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql`
            INSERT OR IGNORE INTO voice_controller_actions (
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
              controller_turn_bound_at,
              closed_at
            )
            SELECT
              ${input.voiceActionId},
              ${input.environmentId},
              ${input.controllerThreadId},
              ${input.transportSessionId},
              ${input.transportRuntimeInstanceId},
              ${input.transportGeneration},
              ${input.handoffId},
              ${input.handoffItemId},
              ${input.clientUserMessageId},
              ${input.controllerRuntimeInstanceId},
              NULL,
              NULL,
              NULL,
              'queued',
              ${input.createdAt},
              NULL,
              NULL
            FROM voice_transport_sessions
            WHERE transport_session_id = ${input.transportSessionId}
              AND environment_id = ${input.environmentId}
              AND owner_kind = 'controller'
              AND owner_id = ${input.controllerThreadId}
              AND controller_thread_id = ${input.controllerThreadId}
              AND runtime_instance_id = ${input.transportRuntimeInstanceId}
              AND generation = ${input.transportGeneration}
              AND state = 'active'
            RETURNING voice_action_id
          `;

          const byId = yield* findById({ voiceActionId: input.voiceActionId });
          if (Option.isSome(byId)) {
            const action = byId.value;
            const exact =
              action.environmentId === input.environmentId &&
              action.controllerThreadId === input.controllerThreadId &&
              action.transportSessionId === input.transportSessionId &&
              action.transportRuntimeInstanceId === input.transportRuntimeInstanceId &&
              action.transportGeneration === input.transportGeneration &&
              action.handoffId === input.handoffId &&
              action.handoffItemId === input.handoffItemId &&
              action.clientUserMessageId === input.clientUserMessageId &&
              action.controllerRuntimeInstanceId === input.controllerRuntimeInstanceId;
            if (!exact) return { _tag: "conflict", action } as const;
            return inserted.length > 0
              ? ({ _tag: "created", action } as const)
              : ({ _tag: "existing", action } as const);
          }

          const byHandoff = yield* findByHandoff({
            transportSessionId: input.transportSessionId,
            handoffId: input.handoffId,
            handoffItemId: input.handoffItemId,
          });
          return {
            _tag: "conflict",
            action: Option.getOrNull(byHandoff),
          } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceControllerActionRepository.createOrReplay:transaction"),
        ),
      );
  };

  const getById: VoiceControllerActionRepositoryShape["getById"] = (voiceActionId) =>
    findById({ voiceActionId }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceControllerActionRepository.getById:query")),
    );

  const listByTransportSessionId: VoiceControllerActionRepositoryShape["listByTransportSessionId"] =
    (transportSessionId) =>
      SqlSchema.findAll({
        Request: Schema.String,
        Result: VoiceControllerAction,
        execute: (sessionId) =>
          sql.unsafe(
            `SELECT ${actionColumns}
             FROM voice_controller_actions
             WHERE transport_session_id = ?
             ORDER BY created_at ASC, voice_action_id ASC`,
            [sessionId],
          ),
      })(transportSessionId).pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceControllerActionRepository.listByTransportSessionId:query"),
        ),
      );

  const listRecentByControllerThreadId: VoiceControllerActionRepositoryShape["listRecentByControllerThreadId"] =
    (controllerThreadId) =>
      SqlSchema.findAll({
        Request: Schema.String,
        Result: VoiceControllerAction,
        execute: (threadId) =>
          sql.unsafe(
            `SELECT ${actionColumns}
             FROM voice_controller_actions
             WHERE controller_thread_id = ?
             ORDER BY created_at DESC, voice_action_id DESC
             LIMIT 256`,
            [threadId],
          ),
      })(controllerThreadId).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "VoiceControllerActionRepository.listRecentByControllerThreadId:query",
          ),
        ),
      );

  const bindControllerTurn: VoiceControllerActionRepositoryShape["bindControllerTurn"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const updated = yield* sql`
            UPDATE voice_controller_actions
            SET
              controller_provider_session_id = ${input.controllerProviderSessionId},
              controller_provider_turn_id = ${input.controllerProviderTurnId},
              controller_turn_bound_at = ${input.boundAt},
              state = 'active'
            WHERE voice_action_id = ${input.voiceActionId}
              AND state = 'queued'
              AND closed_at IS NULL
              AND controller_provider_session_id IS NULL
              AND controller_provider_turn_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM voice_controller_actions other
                WHERE other.voice_action_id <> ${input.voiceActionId}
                  AND other.controller_provider_session_id =
                    ${input.controllerProviderSessionId}
                  AND other.controller_provider_turn_id =
                    ${input.controllerProviderTurnId}
              )
            RETURNING voice_action_id
          `;

          const action = yield* findById({ voiceActionId: input.voiceActionId });
          if (Option.isNone(action)) return { _tag: "not_found" } as const;
          if (updated.length > 0) return { _tag: "bound", action: action.value } as const;
          if (action.value.closedAt !== null) {
            return { _tag: "closed", action: action.value } as const;
          }
          if (
            action.value.controllerProviderSessionId === input.controllerProviderSessionId &&
            action.value.controllerProviderTurnId === input.controllerProviderTurnId
          ) {
            return { _tag: "existing", action: action.value } as const;
          }
          return { _tag: "conflict", action: action.value } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("VoiceControllerActionRepository.bindControllerTurn:transaction"),
        ),
      );

  const resolveOpenByControllerTurn: VoiceControllerActionRepositoryShape["resolveOpenByControllerTurn"] =
    (input) =>
      SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: VoiceControllerAction,
        execute: () =>
          sql.unsafe(
            `SELECT ${actionColumns}
             FROM voice_controller_actions
             WHERE controller_thread_id = ?
               AND controller_runtime_instance_id = ?
               AND controller_provider_session_id = ?
               AND controller_provider_turn_id = ?
               AND state = 'active'
               AND closed_at IS NULL`,
            [
              input.controllerThreadId,
              input.controllerRuntimeInstanceId,
              input.controllerProviderSessionId,
              input.controllerProviderTurnId,
            ],
          ),
      })(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "VoiceControllerActionRepository.resolveOpenByControllerTurn:query",
          ),
        ),
      );

  const close: VoiceControllerActionRepositoryShape["close"] = (input) =>
    sql`
      UPDATE voice_controller_actions
      SET state = ${input.terminalState}, closed_at = ${input.closedAt}
      WHERE voice_action_id = ${input.voiceActionId}
        AND (
          (state IN ('queued', 'active') AND closed_at IS NULL)
          OR
          (state = ${input.terminalState} AND closed_at = ${input.closedAt})
        )
      RETURNING voice_action_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("VoiceControllerActionRepository.close:query")),
    );

  const fenceTransportGeneration: VoiceControllerActionRepositoryShape["fenceTransportGeneration"] =
    (input) =>
      sql`
        UPDATE voice_controller_actions
        SET state = 'expired', closed_at = ${input.closedAt}
        WHERE transport_session_id = ${input.transportSessionId}
          AND transport_generation <= ${input.throughGeneration}
          AND state IN ('queued', 'active')
          AND closed_at IS NULL
        RETURNING voice_action_id
      `.pipe(
        Effect.map((rows) => rows.length),
        Effect.mapError(
          toPersistenceSqlError("VoiceControllerActionRepository.fenceTransportGeneration:query"),
        ),
      );

  return VoiceControllerActionRepository.of({
    createOrReplay,
    getById,
    listByTransportSessionId,
    listRecentByControllerThreadId,
    bindControllerTurn,
    resolveOpenByControllerTurn,
    close,
    fenceTransportGeneration,
  });
});

export const VoiceControllerActionRepositoryLive = Layer.effect(
  VoiceControllerActionRepository,
  makeVoiceControllerActionRepository,
);
