import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PREVIEW_SNAPSHOT_COMPACTION_MARKER } from "../../orchestration/ActivityPayloadProjection.ts";

const LEGACY_MARKER_PATTERN = "[Preview snapshot omitted from activity history:%";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE projection_thread_activities
    SET payload_json = json_set(
      payload_json,
      '$.data.item.result',
      json_object(
        'content',
        json(
          (
            SELECT json_group_array(json(compacted.block))
            FROM (
              SELECT
                0 AS sort_order,
                json_object(
                  'type',
                  'text',
                  'text',
                  ${PREVIEW_SNAPSHOT_COMPACTION_MARKER}
                ) AS block
              UNION ALL
              SELECT
                CAST(content.key AS INTEGER) + 1 AS sort_order,
                content.value AS block
              FROM json_each(
                projection_thread_activities.payload_json,
                '$.data.item.result.content'
              ) AS content
              WHERE content.type = 'object'
                AND json_extract(
                  CASE WHEN content.type = 'object' THEN content.value ELSE '{}' END,
                  '$.type'
                ) = 'image'
              ORDER BY sort_order
            ) AS compacted
          )
        )
      )
    )
    WHERE json_valid(payload_json)
      AND json_extract(
        CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,
        '$.itemType'
      ) = 'mcp_tool_call'
      AND json_extract(
        CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,
        '$.data.item.server'
      ) = 'shuv2code'
      AND json_extract(
        CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,
        '$.data.item.tool'
      ) = 'preview_snapshot'
      AND json_type(
        CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,
        '$.data.item.result'
      ) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(payload_json, '$.data.item.result.content') AS content
        WHERE content.type = 'object'
          AND (
            json_extract(
              CASE WHEN content.type = 'object' THEN content.value ELSE '{}' END,
              '$.text'
            ) = ${PREVIEW_SNAPSHOT_COMPACTION_MARKER}
            OR json_extract(
              CASE WHEN content.type = 'object' THEN content.value ELSE '{}' END,
              '$.text'
            ) LIKE ${LEGACY_MARKER_PATTERN}
          )
      )
  `;
});
