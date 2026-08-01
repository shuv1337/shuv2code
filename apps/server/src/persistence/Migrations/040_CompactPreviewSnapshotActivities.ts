import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE projection_thread_activities
    SET payload_json = json_set(
      payload_json,
      '$.data.item.result',
      json_object(
        'content',
        json_array(
          json_object(
            'type',
            'text',
            'text',
            '[Preview snapshot omitted from activity history: original result length ' ||
              printf(
                '%,d',
                coalesce(
                  (
                    SELECT sum(length(content.value))
                    FROM json_tree(
                      projection_thread_activities.payload_json,
                      '$.data.item.result.content'
                    ) AS content
                    WHERE content.key = 'text'
                      AND content.type = 'text'
                  ),
                  0
                )
              ) ||
              ' characters]'
          )
        )
      )
    )
    WHERE json_extract(payload_json, '$.itemType') = 'mcp_tool_call'
      AND json_extract(payload_json, '$.data.item.server') = 'shuv2code'
      AND json_extract(payload_json, '$.data.item.tool') = 'preview_snapshot'
      AND json_type(payload_json, '$.data.item.result') IS NOT NULL
      AND coalesce(json_extract(payload_json, '$.data.item.result.content[0].text'), '')
        NOT LIKE '[Preview snapshot omitted from activity history:%'
  `;
});
