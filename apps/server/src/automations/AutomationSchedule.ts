import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import type { AutomationValidationResult } from "@shuv2code/contracts";

export interface AutomationScheduleInput {
  readonly cronExpression: string;
  readonly timeZone: string;
}

export function parseAutomationSchedule(
  input: AutomationScheduleInput,
):
  | { readonly ok: true; readonly cron: Cron.Cron }
  | { readonly ok: false; readonly error: string } {
  const parsed = Cron.parse(input.cronExpression, input.timeZone);
  if (Result.isFailure(parsed)) {
    return { ok: false, error: parsed.failure.message };
  }
  return { ok: true, cron: parsed.success };
}

export function nextAutomationRunAt(
  input: AutomationScheduleInput,
  after: DateTime.DateTime.Input,
): string | null {
  const parsed = parseAutomationSchedule(input);
  if (!parsed.ok) return null;
  return DateTime.formatIso(DateTime.makeUnsafe(Cron.next(parsed.cron, after)));
}

export function validateAutomationSchedule(
  input: AutomationScheduleInput,
  after: DateTime.DateTime.Input,
): AutomationValidationResult {
  const parsed = parseAutomationSchedule(input);
  if (!parsed.ok) {
    return { valid: false, nextRunAt: null, error: parsed.error };
  }
  const nextRunAt = DateTime.formatIso(DateTime.makeUnsafe(Cron.next(parsed.cron, after)));
  return { valid: true, nextRunAt, error: null };
}
