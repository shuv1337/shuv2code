import { assert, it } from "@effect/vitest";

import {
  nextAutomationRunAt,
  parseAutomationSchedule,
  validateAutomationSchedule,
} from "./AutomationSchedule.ts";

it("computes a timezone-aware next run", () => {
  assert.strictEqual(
    nextAutomationRunAt(
      { cronExpression: "0 9 * * *", timeZone: "Europe/London" },
      "2026-07-30T07:00:00.000Z",
    ),
    "2026-07-30T08:00:00.000Z",
  );
});

it("preserves local wall time across daylight-saving changes", () => {
  assert.strictEqual(
    nextAutomationRunAt(
      { cronExpression: "0 9 * * *", timeZone: "Europe/London" },
      "2026-10-24T09:01:00.000Z",
    ),
    "2026-10-25T09:00:00.000Z",
  );
  assert.strictEqual(
    nextAutomationRunAt(
      { cronExpression: "0 9 * * *", timeZone: "Europe/London" },
      "2026-03-28T10:00:00.000Z",
    ),
    "2026-03-29T08:00:00.000Z",
  );
});

it("supports half-hour zones and year boundaries", () => {
  assert.strictEqual(
    nextAutomationRunAt(
      { cronExpression: "0 9 * * *", timeZone: "Asia/Kolkata" },
      "2026-12-31T23:59:59.000Z",
    ),
    "2027-01-01T03:30:00.000Z",
  );
});

it("reports invalid cron expressions and time zones", () => {
  assert.strictEqual(parseAutomationSchedule({ cronExpression: "bad", timeZone: "UTC" }).ok, false);
  assert.deepStrictEqual(
    validateAutomationSchedule(
      { cronExpression: "0 9 * * *", timeZone: "Moon/Base" },
      "2026-07-30T07:00:00.000Z",
    ),
    { valid: false, nextRunAt: null, error: "Invalid time zone in cron expression" },
  );
});
