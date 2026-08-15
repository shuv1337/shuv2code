import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  VoiceTransportSessionRepository,
  type VoiceTransportSessionRepositoryShape,
} from "../Services/VoiceTransportSessions.ts";
import { VoiceTransportSession } from "../VoiceControlModels.ts";

const ownerKind = (
  owner: Parameters<VoiceTransportSessionRepositoryShape["openOrReplay"]>[0]["owner"],
) =>
  owner.kind === "controller"
    ? "controller"
    : owner.kind === "thread-call"
      ? "thread-call"
      : "transcription-test";

const ownerId = (
  owner: Parameters<VoiceTransportSessionRepositoryShape["openOrReplay"]>[0]["owner"],
) =>
  owner.kind === "controller"
    ? owner.controllerThreadId
    : owner.kind === "thread-call"
      ? owner.threadId
      : owner.requestId;

const ownerAnchor = (
  owner: Parameters<VoiceTransportSessionRepositoryShape["openOrReplay"]>[0]["owner"],
) => (owner.kind === "transcription-test" ? owner.providerAnchorThreadId : null);

const TransportSessionIdRequest = Schema.Struct({
  transportSessionId: Schema.String,
});

const makeVoiceTransportSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findById = SqlSchema.findOneOption({
    Request: TransportSessionIdRequest,
    Result: VoiceTransportSession,
    execute: ({ transportSessionId }) =>
      sql`
        SELECT
          transport_session_id AS "transportSessionId",
          environment_id AS "environmentId",
          call_id AS "callId",
          device_id AS "deviceId",
          device_label AS "deviceLabel",
          device_kind AS "deviceKind",
          owner_kind AS "ownerKind",
          owner_id AS "ownerId",
          provider_anchor_thread_id AS "anchorThreadId",
          controller_thread_id AS "controllerThreadId",
          transport_thread_id AS "transportThreadId",
          runtime_instance_id AS "runtimeInstanceId",
          generation,
          realtime_session_id AS "realtimeSessionId",
          state,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          closed_at AS "closedAt"
        FROM voice_transport_sessions
        WHERE transport_session_id = ${transportSessionId}
      `,
  });

  const findOpenByEnvironment = SqlSchema.findOneOption({
    Request: VoiceTransportSession.fields.environmentId,
    Result: VoiceTransportSession,
    execute: (environmentId) =>
      sql`
        SELECT
          transport_session_id AS "transportSessionId",
          environment_id AS "environmentId",
          call_id AS "callId",
          device_id AS "deviceId",
          device_label AS "deviceLabel",
          device_kind AS "deviceKind",
          owner_kind AS "ownerKind",
          owner_id AS "ownerId",
          provider_anchor_thread_id AS "anchorThreadId",
          controller_thread_id AS "controllerThreadId",
          transport_thread_id AS "transportThreadId",
          runtime_instance_id AS "runtimeInstanceId",
          generation,
          realtime_session_id AS "realtimeSessionId",
          state,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          closed_at AS "closedAt"
        FROM voice_transport_sessions
        WHERE environment_id = ${environmentId}
          AND state IN ('negotiating', 'active', 'closing')
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `,
  });

  const open = (
    input: Parameters<VoiceTransportSessionRepositoryShape["openOrReplay"]>[0],
    allowActiveListener: boolean,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const replay = yield* findById({ transportSessionId: input.transportSessionId });
          if (Option.isSome(replay)) {
            const session = replay.value;
            const exact =
              session.environmentId === input.environmentId &&
              session.callId === (input.callId ?? null) &&
              session.deviceId === (input.device?.deviceId ?? null) &&
              session.deviceLabel === (input.device?.label ?? null) &&
              session.deviceKind === (input.device?.kind ?? null) &&
              session.ownerKind === ownerKind(input.owner) &&
              session.ownerId === ownerId(input.owner) &&
              session.anchorThreadId === ownerAnchor(input.owner) &&
              session.controllerThreadId === input.controllerThreadId &&
              session.transportThreadId === input.transportThreadId &&
              session.runtimeInstanceId === input.runtimeInstanceId &&
              session.generation === input.generation;
            return exact
              ? ({ _tag: "existing", session } as const)
              : ({ _tag: "conflict", session } as const);
          }

          if (!allowActiveListener) {
            const open = yield* findOpenByEnvironment(input.environmentId);
            if (Option.isSome(open)) return { _tag: "conflict", session: open.value } as const;
          }

          const inserted = yield* sql`
            INSERT OR IGNORE INTO voice_transport_sessions (
              transport_session_id,
              environment_id,
              call_id,
              device_id,
              device_label,
              device_kind,
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
              updated_at,
              closed_at
            )
            VALUES (
              ${input.transportSessionId},
              ${input.environmentId},
              ${input.callId ?? null},
              ${input.device?.deviceId ?? null},
              ${input.device?.label ?? null},
              ${input.device?.kind ?? null},
              ${input.controllerThreadId},
              ${ownerKind(input.owner)},
              ${ownerId(input.owner)},
              ${
                input.owner.kind === "transcription-test"
                  ? input.owner.providerAnchorThreadId
                  : null
              },
              ${input.transportThreadId},
              ${input.runtimeInstanceId},
              ${input.generation},
              NULL,
              'negotiating',
              ${input.createdAt},
              ${input.createdAt},
              NULL
            )
            RETURNING transport_session_id
          `;

          const byId = yield* findById({ transportSessionId: input.transportSessionId });
          if (Option.isSome(byId)) {
            const session = byId.value;
            const exact =
              session.environmentId === input.environmentId &&
              session.callId === (input.callId ?? null) &&
              session.deviceId === (input.device?.deviceId ?? null) &&
              session.deviceLabel === (input.device?.label ?? null) &&
              session.deviceKind === (input.device?.kind ?? null) &&
              session.ownerKind === ownerKind(input.owner) &&
              session.ownerId === ownerId(input.owner) &&
              session.anchorThreadId === ownerAnchor(input.owner) &&
              session.controllerThreadId === input.controllerThreadId &&
              session.transportThreadId === input.transportThreadId &&
              session.runtimeInstanceId === input.runtimeInstanceId &&
              session.generation === input.generation;
            if (!exact) return { _tag: "conflict", session } as const;
            return inserted.length > 0
              ? ({ _tag: "created", session } as const)
              : ({ _tag: "existing", session } as const);
          }

          const open = yield* findOpenByEnvironment(input.environmentId);
          return {
            _tag: "conflict",
            session: Option.getOrNull(open),
          } as const;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("VoiceTransportSessionRepository.open:transaction")),
      );

  const openOrReplay: VoiceTransportSessionRepositoryShape["openOrReplay"] = (input) =>
    open(input, false);

  const openHandoffOrReplay: VoiceTransportSessionRepositoryShape["openHandoffOrReplay"] = (
    input,
  ) => open(input, true);

  const getById: VoiceTransportSessionRepositoryShape["getById"] = (transportSessionId) =>
    findById({ transportSessionId }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceTransportSessionRepository.getById:query")),
    );

  const getOpenByEnvironmentId: VoiceTransportSessionRepositoryShape["getOpenByEnvironmentId"] = (
    environmentId,
  ) =>
    findOpenByEnvironment(environmentId).pipe(
      Effect.mapError(
        toPersistenceSqlError("VoiceTransportSessionRepository.getOpenByEnvironmentId:query"),
      ),
    );

  const activate: VoiceTransportSessionRepositoryShape["activate"] = (input) =>
    sql`
      UPDATE voice_transport_sessions
      SET
        realtime_session_id = ${input.realtimeSessionId},
        state = 'active',
        updated_at = ${input.updatedAt}
      WHERE transport_session_id = ${input.transportSessionId}
        AND generation = ${input.generation}
        AND runtime_instance_id = ${input.runtimeInstanceId}
        AND state = 'negotiating'
      RETURNING transport_session_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("VoiceTransportSessionRepository.activate:query")),
    );

  const compareAndSetState: VoiceTransportSessionRepositoryShape["compareAndSetState"] = (input) =>
    sql`
      UPDATE voice_transport_sessions
      SET
        state = ${input.nextState},
        updated_at = ${input.updatedAt},
        closed_at = ${input.closedAt}
      WHERE transport_session_id = ${input.transportSessionId}
        AND generation = ${input.generation}
        AND runtime_instance_id = ${input.runtimeInstanceId}
        AND state = ${input.expectedState}
      RETURNING transport_session_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("VoiceTransportSessionRepository.compareAndSetState:query"),
      ),
    );

  const fenceGeneration: VoiceTransportSessionRepositoryShape["fenceGeneration"] = (input) =>
    sql`
      UPDATE voice_transport_sessions
      SET
        state = 'fenced',
        updated_at = ${input.fencedAt},
        closed_at = ${input.fencedAt}
      WHERE environment_id = ${input.environmentId}
        AND generation <= ${input.throughGeneration}
        AND state IN ('negotiating', 'active', 'closing')
      RETURNING transport_session_id
    `.pipe(
      Effect.map((rows) => rows.length),
      Effect.mapError(
        toPersistenceSqlError("VoiceTransportSessionRepository.fenceGeneration:query"),
      ),
    );

  return VoiceTransportSessionRepository.of({
    openOrReplay,
    openHandoffOrReplay,
    getById,
    getOpenByEnvironmentId,
    activate,
    compareAndSetState,
    fenceGeneration,
  });
});

export const VoiceTransportSessionRepositoryLive = Layer.effect(
  VoiceTransportSessionRepository,
  makeVoiceTransportSessionRepository,
);
