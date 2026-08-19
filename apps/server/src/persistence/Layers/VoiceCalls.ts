import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CompareAndSetVoiceCallListenerInput,
  CreateVoiceCallInput,
  VoiceCallRepository,
  type VoiceCallRepositoryShape,
} from "../Services/VoiceCalls.ts";
import { VoiceCall } from "../VoiceControlModels.ts";

const VoiceCallIdRequest = Schema.Struct({ callId: CreateVoiceCallInput.fields.callId });

class VoiceCallListenerPromotionConflict extends Data.TaggedError(
  "VoiceCallListenerPromotionConflict",
) {}

const selectVoiceCall = `
  call_id AS "callId",
  environment_id AS "environmentId",
  thread_id AS "threadId",
  state,
  active_transport_session_id AS "activeTransportSessionId",
  active_device_id AS "activeDeviceId",
  active_device_label AS "activeDeviceLabel",
  active_device_kind AS "activeDeviceKind",
  revision,
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  ended_at AS "endedAt"
`;

const makeVoiceCallRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findById = SqlSchema.findOneOption({
    Request: VoiceCallIdRequest,
    Result: VoiceCall,
    execute: ({ callId }) =>
      sql.unsafe(`SELECT ${selectVoiceCall} FROM voice_calls WHERE call_id = ?`, [callId]),
  });

  const findActiveByEnvironment = SqlSchema.findOneOption({
    Request: CreateVoiceCallInput.fields.environmentId,
    Result: VoiceCall,
    execute: (environmentId) =>
      sql.unsafe(
        `SELECT ${selectVoiceCall} FROM voice_calls WHERE environment_id = ? AND state = 'active' ORDER BY updated_at DESC LIMIT 1`,
        [environmentId],
      ),
  });

  const create: VoiceCallRepositoryShape["create"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql`
            INSERT OR IGNORE INTO voice_calls (
              call_id,
              environment_id,
              thread_id,
              state,
              active_transport_session_id,
              active_device_id,
              active_device_label,
              active_device_kind,
              revision,
              created_at,
              updated_at,
              ended_at
            ) VALUES (
              ${input.callId},
              ${input.environmentId},
              ${input.threadId},
              'active',
              ${input.activeTransportSessionId},
              ${input.activeDevice.deviceId},
              ${input.activeDevice.label},
              ${input.activeDevice.kind},
              1,
              ${input.createdAt},
              ${input.createdAt},
              NULL
            )
            RETURNING call_id
          `;
          const byId = yield* findById({ callId: input.callId });
          if (Option.isSome(byId)) {
            const call = byId.value;
            const exact =
              call.environmentId === input.environmentId &&
              call.threadId === input.threadId &&
              call.activeTransportSessionId === input.activeTransportSessionId &&
              call.activeDeviceId === input.activeDevice.deviceId &&
              call.activeDeviceLabel === input.activeDevice.label &&
              call.activeDeviceKind === input.activeDevice.kind;
            if (!exact) return { _tag: "conflict", call } as const;
            return inserted.length > 0
              ? ({ _tag: "created", call } as const)
              : ({ _tag: "existing", call } as const);
          }
          const active = yield* findActiveByEnvironment(input.environmentId);
          return { _tag: "conflict", call: Option.getOrNull(active) } as const;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("VoiceCallRepository.create:transaction")));

  const getById: VoiceCallRepositoryShape["getById"] = (callId) =>
    findById({ callId }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceCallRepository.getById:query")),
    );

  const getActiveByEnvironmentId: VoiceCallRepositoryShape["getActiveByEnvironmentId"] = (
    environmentId,
  ) =>
    findActiveByEnvironment(environmentId).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceCallRepository.getActiveByEnvironmentId:query")),
    );

  const updateListener = SqlSchema.findOneOption({
    Request: CompareAndSetVoiceCallListenerInput,
    Result: VoiceCall,
    execute: (input) =>
      sql.unsafe(
        `UPDATE voice_calls
         SET
           thread_id = ?,
           state = ?,
           active_transport_session_id = ?,
           active_device_id = ?,
           active_device_label = ?,
           active_device_kind = ?,
           revision = revision + 1,
           updated_at = ?,
           ended_at = ?
         WHERE call_id = ?
           AND revision = ?
           AND active_transport_session_id IS ?
         RETURNING ${selectVoiceCall}`,
        [
          input.threadId,
          input.state,
          input.activeTransportSessionId,
          input.activeDevice?.deviceId ?? null,
          input.activeDevice?.label ?? null,
          input.activeDevice?.kind ?? null,
          input.updatedAt,
          input.endedAt,
          input.callId,
          input.expectedRevision,
          input.expectedActiveTransportSessionId,
        ],
      ),
  });

  const compareAndSetListener: VoiceCallRepositoryShape["compareAndSetListener"] = (input) =>
    updateListener(input).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceCallRepository.compareAndSetListener:query")),
    );

  const promoteListener: VoiceCallRepositoryShape["promoteListener"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* findById({ callId: input.callId });
          if (
            Option.isNone(current) ||
            current.value.state !== "active" ||
            current.value.revision !== input.expectedRevision ||
            current.value.activeTransportSessionId !== input.expectedActiveTransportSessionId
          ) {
            return yield* new VoiceCallListenerPromotionConflict();
          }

          const next = yield* sql`
            SELECT transport_session_id
            FROM voice_transport_sessions
            WHERE transport_session_id = ${input.nextTransportSessionId}
              AND call_id = ${input.callId}
              AND generation = ${input.nextGeneration}
              AND runtime_instance_id = ${input.nextRuntimeInstanceId}
              AND state = 'negotiating'
          `;
          if (next.length !== 1) return yield* new VoiceCallListenerPromotionConflict();

          const previous = yield* sql`
            UPDATE voice_transport_sessions
            SET state = 'fenced', updated_at = ${input.updatedAt}, closed_at = ${input.updatedAt}
            WHERE transport_session_id = ${input.expectedActiveTransportSessionId}
              AND call_id = ${input.callId}
              AND state = 'active'
            RETURNING transport_session_id
          `;
          if (previous.length !== 1) return yield* new VoiceCallListenerPromotionConflict();

          const activated = yield* sql`
            UPDATE voice_transport_sessions
            SET
              realtime_session_id = ${input.nextRealtimeSessionId},
              state = 'active',
              updated_at = ${input.updatedAt}
            WHERE transport_session_id = ${input.nextTransportSessionId}
              AND generation = ${input.nextGeneration}
              AND runtime_instance_id = ${input.nextRuntimeInstanceId}
              AND state = 'negotiating'
            RETURNING transport_session_id
          `;
          if (activated.length !== 1) return yield* new VoiceCallListenerPromotionConflict();

          const promoted = yield* sql`
            UPDATE voice_calls
            SET
              thread_id = ${input.threadId},
              active_transport_session_id = ${input.nextTransportSessionId},
              active_device_id = ${input.activeDevice.deviceId},
              active_device_label = ${input.activeDevice.label},
              active_device_kind = ${input.activeDevice.kind},
              revision = revision + 1,
              updated_at = ${input.updatedAt}
            WHERE call_id = ${input.callId}
              AND state = 'active'
              AND revision = ${input.expectedRevision}
              AND active_transport_session_id = ${input.expectedActiveTransportSessionId}
            RETURNING call_id
          `;
          if (promoted.length !== 1) return yield* new VoiceCallListenerPromotionConflict();
          return yield* findById({ callId: input.callId });
        }),
      )
      .pipe(
        Effect.catchTag("VoiceCallListenerPromotionConflict", () => Effect.succeed(Option.none())),
        Effect.mapError(toPersistenceSqlError("VoiceCallRepository.promoteListener:transaction")),
      );

  return VoiceCallRepository.of({
    create,
    getById,
    getActiveByEnvironmentId,
    compareAndSetListener,
    promoteListener,
  });
});

export const VoiceCallRepositoryLive = Layer.effect(VoiceCallRepository, makeVoiceCallRepository);
