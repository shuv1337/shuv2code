import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AppendVoiceCallEventInput,
  VoiceCallEventRepository,
  type VoiceCallEventRepositoryShape,
} from "../Services/VoiceCallEvents.ts";
import { VoiceCallEvent } from "../VoiceControlModels.ts";

const VoiceCallEventDbRow = VoiceCallEvent.mapFields(
  Struct.assign({ payload: Schema.fromJsonString(Schema.Unknown) }),
);
const VoiceCallThreadRequest = Schema.Struct({
  environmentId: AppendVoiceCallEventInput.fields.environmentId,
  threadId: AppendVoiceCallEventInput.fields.threadId,
});
const VoiceCallThreadCursorRequest = Schema.Struct({
  ...VoiceCallThreadRequest.fields,
  afterEventId: Schema.Number,
});

const makeVoiceCallEventRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEvent = SqlSchema.findAll({
    Request: AppendVoiceCallEventInput,
    Result: VoiceCallEventDbRow,
    execute: (input) => sql`
        INSERT INTO voice_call_events (
          environment_id,
          thread_id,
          call_id,
          device_id,
          transport_session_id,
          generation,
          kind,
          correlation_id,
          thread_snapshot_sequence,
          payload_json,
          occurred_at
        ) VALUES (
          ${input.environmentId},
          ${input.threadId},
          ${input.callId ?? null},
          ${input.deviceId ?? null},
          ${input.transportSessionId},
          ${input.generation},
          ${input.kind},
          ${input.correlationId},
          ${input.threadSnapshotSequence},
          ${JSON.stringify(input.payload)},
          ${input.occurredAt}
        )
        RETURNING
          event_id AS "eventId",
          environment_id AS "environmentId",
          thread_id AS "threadId",
          call_id AS "callId",
          device_id AS "deviceId",
          transport_session_id AS "transportSessionId",
          generation,
          kind,
          correlation_id AS "correlationId",
          thread_snapshot_sequence AS "threadSnapshotSequence",
          payload_json AS payload,
          occurred_at AS "occurredAt"
      `,
  });

  const findLatestListenerEvent = SqlSchema.findOneOption({
    Request: VoiceCallThreadRequest,
    Result: VoiceCallEventDbRow,
    execute: (input) => sql`
        SELECT
          event_id AS "eventId",
          environment_id AS "environmentId",
          thread_id AS "threadId",
          call_id AS "callId",
          device_id AS "deviceId",
          transport_session_id AS "transportSessionId",
          generation,
          kind,
          correlation_id AS "correlationId",
          thread_snapshot_sequence AS "threadSnapshotSequence",
          payload_json AS payload,
          occurred_at AS "occurredAt"
        FROM voice_call_events
        WHERE environment_id = ${input.environmentId}
          AND thread_id = ${input.threadId}
          AND kind IN ('listener.attached', 'listener.detached')
        ORDER BY event_id DESC
        LIMIT 1
      `,
  });

  const listThreadEvents = SqlSchema.findAll({
    Request: VoiceCallThreadCursorRequest,
    Result: VoiceCallEventDbRow,
    execute: (input) => sql`
        SELECT
          event_id AS "eventId",
          environment_id AS "environmentId",
          thread_id AS "threadId",
          call_id AS "callId",
          device_id AS "deviceId",
          transport_session_id AS "transportSessionId",
          generation,
          kind,
          correlation_id AS "correlationId",
          thread_snapshot_sequence AS "threadSnapshotSequence",
          payload_json AS payload,
          occurred_at AS "occurredAt"
        FROM voice_call_events
        WHERE environment_id = ${input.environmentId}
          AND thread_id = ${input.threadId}
          AND event_id > ${input.afterEventId}
        ORDER BY event_id ASC
      `,
  });

  const append: VoiceCallEventRepositoryShape["append"] = (input) =>
    appendEvent(input).pipe(
      Effect.map((rows) => rows[0]!),
      Effect.mapError(toPersistenceSqlError("VoiceCallEventRepository.append:query")),
    );

  const getLatestListenerEvent: VoiceCallEventRepositoryShape["getLatestListenerEvent"] = (input) =>
    findLatestListenerEvent(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("VoiceCallEventRepository.getLatestListenerEvent:query"),
      ),
    );

  const listByThreadId: VoiceCallEventRepositoryShape["listByThreadId"] = (input) =>
    listThreadEvents({ ...input, afterEventId: input.afterEventId ?? 0 }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceCallEventRepository.listByThreadId:query")),
    );

  return VoiceCallEventRepository.of({ append, getLatestListenerEvent, listByThreadId });
});

export const VoiceCallEventRepositoryLive = Layer.effect(
  VoiceCallEventRepository,
  makeVoiceCallEventRepository,
);
