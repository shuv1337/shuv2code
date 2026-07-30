import {
  AutomationCronExpression,
  AutomationName,
  AutomationPrompt,
  AutomationTimeZone,
  type AutomationValidateScheduleInput,
} from "@shuv2code/contracts";

type ParseResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

export function parseAutomationScheduleFields(
  cronExpression: string,
  timeZone: string,
): ParseResult<AutomationValidateScheduleInput> {
  const cron = cronExpression.trim();
  const zone = timeZone.trim();
  if (cron.length === 0) return { ok: false, error: "Enter a cron schedule." };
  if (cron.length > 160)
    return { ok: false, error: "Cron schedule must be 160 characters or less." };
  if (zone.length === 0) return { ok: false, error: "Enter a time zone." };
  if (zone.length > 128) return { ok: false, error: "Time zone must be 128 characters or less." };
  return {
    ok: true,
    value: {
      cronExpression: AutomationCronExpression.make(cron),
      timeZone: AutomationTimeZone.make(zone),
    },
  };
}

export function parseAutomationTextFields(
  name: string,
  prompt: string,
): ParseResult<{
  readonly name: AutomationName;
  readonly prompt: AutomationPrompt;
}> {
  const normalizedName = name.trim();
  const normalizedPrompt = prompt.trim();
  if (normalizedName.length === 0) return { ok: false, error: "Enter a name." };
  if (normalizedName.length > 160)
    return { ok: false, error: "Name must be 160 characters or less." };
  if (normalizedPrompt.length === 0) return { ok: false, error: "Enter instructions." };
  if (normalizedPrompt.length > 120_000)
    return { ok: false, error: "Instructions must be 120,000 characters or less." };
  return {
    ok: true,
    value: {
      name: AutomationName.make(normalizedName),
      prompt: AutomationPrompt.make(normalizedPrompt),
    },
  };
}
