import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DurableThreadControlGrant,
  ThreadControlGrantRepository,
  type ThreadControlGrantRepositoryShape,
} from "../Services/ThreadControlGrants.ts";

const StoredGrant = Schema.Struct({
  ...DurableThreadControlGrant.fields,
  controlEnabled: Schema.Number.pipe(Schema.decodeTo(Schema.BooleanFromBit)),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const find = SqlSchema.findOneOption({
    Request: DurableThreadControlGrant.fields.threadId,
    Result: StoredGrant,
    execute: (threadId) => sql`
      SELECT
        thread_id AS "threadId",
        authorized_runtime_ceiling AS "authorizedRuntimeCeiling",
        control_enabled AS "controlEnabled",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_control_grants
      WHERE thread_id = ${threadId}
    `,
  });

  const getByThreadId: ThreadControlGrantRepositoryShape["getByThreadId"] = (threadId) =>
    find(threadId).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadControlGrantRepository.getByThreadId")),
    );

  const upsert: ThreadControlGrantRepositoryShape["upsert"] = (grant) =>
    sql`
      INSERT INTO thread_control_grants (
        thread_id, authorized_runtime_ceiling, control_enabled, created_at, updated_at
      ) VALUES (
        ${grant.threadId}, ${grant.authorizedRuntimeCeiling},
        ${grant.controlEnabled ? 1 : 0}, ${grant.createdAt}, ${grant.updatedAt}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        authorized_runtime_ceiling = excluded.authorized_runtime_ceiling,
        control_enabled = excluded.control_enabled,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ThreadControlGrantRepository.upsert")),
    );

  const revoke: ThreadControlGrantRepositoryShape["revoke"] = (threadId) =>
    sql`DELETE FROM thread_control_grants WHERE thread_id = ${threadId} RETURNING thread_id`.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("ThreadControlGrantRepository.revoke")),
    );

  return ThreadControlGrantRepository.of({ getByThreadId, upsert, revoke });
});

export const ThreadControlGrantRepositoryLive = Layer.effect(ThreadControlGrantRepository, make);
