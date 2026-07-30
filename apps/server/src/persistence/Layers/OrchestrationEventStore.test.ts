import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@shuv2code/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("replays one indexed aggregate without decoding unrelated global history", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const targetThreadId = ThreadId.make("thread-indexed-target");
      const targetProjectId = ProjectId.make("project-indexed-target");
      const startRows = yield* sql<{ readonly sequence: number }>`
        SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
      `;
      const startSequence = startRows[0]?.sequence ?? 0;

      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, index) => index),
        (index) =>
          eventStore.append({
            type: "project.created",
            eventId: EventId.make(`evt-unrelated-${index}`),
            aggregateKind: "project",
            aggregateId: ProjectId.make(`project-unrelated-${index}`),
            occurredAt: now,
            commandId: CommandId.make(`cmd-unrelated-${index}`),
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId: ProjectId.make(`project-unrelated-${index}`),
              title: `Unrelated ${index}`,
              workspaceRoot: `/tmp/unrelated-${index}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          }),
        { discard: true },
      );

      const created = yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-indexed-thread-created"),
        aggregateKind: "thread",
        aggregateId: targetThreadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-indexed-thread-created"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: targetThreadId,
          projectId: targetProjectId,
          title: "Indexed target",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const deleted = yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.make("evt-indexed-thread-deleted"),
        aggregateKind: "thread",
        aggregateId: targetThreadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-indexed-thread-deleted"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: targetThreadId, deletedAt: now },
      });

      const targeted = yield* Stream.runCollect(
        eventStore.readAggregateFromSequence("thread", targetThreadId, startSequence, 10),
      ).pipe(Effect.map((events) => Array.from(events)));
      const afterCreate = yield* Stream.runCollect(
        eventStore.readAggregateFromSequence("thread", targetThreadId, created.sequence, 10),
      ).pipe(Effect.map((events) => Array.from(events)));

      const globalCountRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE sequence > ${startSequence}
      `;
      assert.equal(globalCountRows[0]?.count, 102);
      assert.deepEqual(
        targeted.map(({ sequence }) => sequence),
        [created.sequence, deleted.sequence],
      );
      assert.deepEqual(
        afterCreate.map(({ sequence }) => sequence),
        [deleted.sequence],
      );

      const queryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT sequence
        FROM orchestration_events
        WHERE aggregate_kind = ${"thread"}
          AND stream_id = ${targetThreadId}
          AND sequence > ${0}
        ORDER BY sequence ASC
        LIMIT ${10}
      `;
      assert.ok(queryPlan.some(({ detail }) => detail.includes("idx_orch_events_stream_sequence")));
    }),
  );
});
