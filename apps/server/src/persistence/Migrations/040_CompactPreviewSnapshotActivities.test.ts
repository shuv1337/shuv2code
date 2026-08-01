import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_CompactPreviewSnapshotActivities", (it) => {
  it.effect("compacts historical preview results without rewriting events or row metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-preview',
            'thread-1',
            'turn-1',
            'tool',
            'tool.completed',
            'shuv2code · preview_snapshot',
            '{"itemType":"mcp_tool_call","status":"completed","data":{"completedAtMs":1234,"item":{"type":"mcpToolCall","id":"preview-call","server":"shuv2code","tool":"preview_snapshot","arguments":{"tabId":"tab_1"},"durationMs":125,"status":"completed","result":{"content":["plain",{"type":"text","text":"SNAPSHOT_PAYLOAD_SHOULD_BE_REMOVED"},{"type":"text","text":"SECOND"}],"structuredContent":{"snapshot":"SNAPSHOT_PAYLOAD_SHOULD_BE_REMOVED"}}}}}',
            42,
            '2026-08-01T00:00:00.000Z'
          ),
          (
            'activity-other-mcp',
            'thread-1',
            'turn-1',
            'tool',
            'tool.completed',
            'other · read',
            '{"itemType":"mcp_tool_call","data":{"item":{"server":"other","tool":"read","result":{"content":[{"type":"text","text":"SNAPSHOT_PAYLOAD_SHOULD_BE_REMOVED"}]}}}}',
            43,
            '2026-08-01T00:00:01.000Z'
          ),
          (
            'activity-already-compacted',
            'thread-1',
            'turn-1',
            'tool',
            'tool.completed',
            'shuv2code · preview_snapshot',
            '{"itemType":"mcp_tool_call","data":{"item":{"server":"shuv2code","tool":"preview_snapshot","result":{"content":[{"type":"text","text":"[Preview snapshot omitted from activity history: original result length 99 characters]"}]}}}}',
            44,
            '2026-08-01T00:00:02.000Z'
          )
      `;

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
          'event-preview',
          'thread',
          'thread-1',
          1,
          'thread.activity-appended',
          '2026-08-01T00:00:00.000Z',
          'command-preview',
          NULL,
          'correlation-preview',
          'system',
          '{"threadId":"thread-1","activity":{"id":"activity-preview","payload":{"itemType":"mcp_tool_call","data":{"item":{"server":"shuv2code","tool":"preview_snapshot","result":{"content":[{"type":"text","text":"SNAPSHOT_PAYLOAD_SHOULD_BE_REMOVED"}]}}}}}}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const previewRows = yield* sql<{
        readonly activityId: string;
        readonly threadId: string;
        readonly turnId: string | null;
        readonly tone: string;
        readonly kind: string;
        readonly summary: string;
        readonly sequence: number | null;
        readonly createdAt: string;
        readonly server: string;
        readonly tool: string;
        readonly tabId: string;
        readonly durationMs: number;
        readonly status: string;
        readonly resultText: string;
        readonly containsSnapshot: number;
      }>`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          sequence,
          created_at AS "createdAt",
          json_extract(payload_json, '$.data.item.server') AS "server",
          json_extract(payload_json, '$.data.item.tool') AS "tool",
          json_extract(payload_json, '$.data.item.arguments.tabId') AS "tabId",
          json_extract(payload_json, '$.data.item.durationMs') AS "durationMs",
          json_extract(payload_json, '$.data.item.status') AS "status",
          json_extract(payload_json, '$.data.item.result.content[0].text') AS "resultText",
          instr(payload_json, 'SNAPSHOT_PAYLOAD_SHOULD_BE_REMOVED') AS "containsSnapshot"
        FROM projection_thread_activities
        WHERE activity_id = 'activity-preview'
      `;
      assert.deepEqual(previewRows, [
        {
          activityId: "activity-preview",
          threadId: "thread-1",
          turnId: "turn-1",
          tone: "tool",
          kind: "tool.completed",
          summary: "shuv2code · preview_snapshot",
          sequence: 42,
          createdAt: "2026-08-01T00:00:00.000Z",
          server: "shuv2code",
          tool: "preview_snapshot",
          tabId: "tab_1",
          durationMs: 125,
          status: "completed",
          resultText:
            "[Preview snapshot omitted from activity history: original result length 40 characters]",
          containsSnapshot: 0,
        },
      ]);

      const untouchedRows = yield* sql<{
        readonly activityId: string;
        readonly resultText: string;
      }>`
        SELECT
          activity_id AS "activityId",
          json_extract(payload_json, '$.data.item.result.content[0].text') AS "resultText"
        FROM projection_thread_activities
        WHERE activity_id IN ('activity-other-mcp', 'activity-already-compacted')
        ORDER BY activity_id
      `;
      assert.deepEqual(untouchedRows, [
        {
          activityId: "activity-already-compacted",
          resultText:
            "[Preview snapshot omitted from activity history: original result length 99 characters]",
        },
        {
          activityId: "activity-other-mcp",
          resultText: "SNAPSHOT_PAYLOAD_SHOULD_BE_REMOVED",
        },
      ]);

      const eventRows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_id = 'event-preview'
      `;
      assert.strictEqual(eventRows.length, 1);
      assert.include(eventRows[0]!.payloadJson, "SNAPSHOT_PAYLOAD_SHOULD_BE_REMOVED");
    }),
  );
});
