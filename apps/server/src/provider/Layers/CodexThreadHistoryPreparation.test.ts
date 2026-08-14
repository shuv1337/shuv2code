import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  interpretCodexRolloutMigrationReport,
  parseCodexRolloutMigrationReport,
} from "./CodexThreadHistoryPreparation.ts";

const providerThreadId = "89d70e15-4839-44eb-9c8b-a474cc2dd0af";

describe("Codex thread history preparation", () => {
  it("requires approval for an eligible exact thread", () => {
    const report = parseCodexRolloutMigrationReport(
      JSON.stringify({
        outcomes: [
          {
            thread_id: providerThreadId,
            rollout_path: "/redacted/rollout.jsonl",
            status: "eligible",
            bytes_processed: 902_000_000,
            message: null,
          },
        ],
      }),
    );
    NodeAssert.ok(report);
    NodeAssert.deepStrictEqual(
      interpretCodexRolloutMigrationReport({
        report,
        providerThreadId,
        action: "inspect",
      }),
      { state: "migration-required", bytesToProcess: 902_000_000 },
    );
  });

  it("accepts only a migrated or already-paginated exact thread", () => {
    for (const status of ["migrated", "already_paginated"] as const) {
      const report = parseCodexRolloutMigrationReport(
        JSON.stringify({
          outcomes: [
            {
              thread_id: providerThreadId,
              rollout_path: "/redacted/rollout.jsonl",
              status,
              bytes_processed: 42,
              message: null,
            },
          ],
        }),
      );
      NodeAssert.ok(report);
      NodeAssert.deepStrictEqual(
        interpretCodexRolloutMigrationReport({
          report,
          providerThreadId,
          action: "migrate",
        }),
        { state: "ready", historyMode: "paginated" },
      );
    }
  });

  it("fails closed when the report is malformed or belongs to another thread", () => {
    NodeAssert.equal(parseCodexRolloutMigrationReport('{"outcomes":"wrong"}'), undefined);
    const report = parseCodexRolloutMigrationReport(
      JSON.stringify({
        outcomes: [
          {
            thread_id: "another-thread",
            rollout_path: "/redacted/rollout.jsonl",
            status: "already_paginated",
            bytes_processed: 42,
            message: null,
          },
        ],
      }),
    );
    NodeAssert.ok(report);
    NodeAssert.equal(
      interpretCodexRolloutMigrationReport({
        report,
        providerThreadId,
        action: "inspect",
      }).state,
      "not-found",
    );
  });
});
