import {
  AUTOMATION_SUMMARY_PREVIEW_CODE_POINTS,
  AutomationCronExpression,
  AutomationName,
  AutomationPrompt,
  AutomationTimeZone,
  type AutomationConcurrencyPolicy,
  type AutomationRun,
  type ModelSelection,
  type ProjectAutomation,
  type ProjectAutomationSummary,
  type ProviderInteractionMode,
  type RuntimeMode,
  type AutomationValidateScheduleInput,
} from "@shuv2code/contracts";

type ParseResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

/**
 * The automation editor's raw field state — strings as typed, not yet
 * validated into branded contract types.
 *
 * It lives here rather than beside the form because two surfaces now render
 * that form: Settings → Automations, and the captain rail's Routines panel
 * (`docs/ade/MESSENGER-PIVOT.md` §2, M6). A second copy of this shape is how
 * the two would drift a field apart.
 */
export type AutomationFormValue = {
  readonly name: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly concurrencyPolicy: AutomationConcurrencyPolicy;
};

/** 09:00, Monday–Friday — the placeholder the cron field also documents. */
export const DEFAULT_AUTOMATION_CRON = "0 9 * * 1-5";

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * A blank automation, disabled.
 *
 * `enabled: false` is the load-bearing default: a routine created from a rail
 * in two clicks must not start running on a schedule the captain has not read
 * back to themselves.
 */
export function emptyAutomationFormValue(modelSelection: ModelSelection): AutomationFormValue {
  return {
    name: "",
    prompt: "",
    enabled: false,
    cronExpression: DEFAULT_AUTOMATION_CRON,
    timeZone: browserTimeZone(),
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    concurrencyPolicy: "skip",
  };
}

/**
 * Validate a whole form into the fields `automations.create` and
 * `automations.update` share. Both surfaces submit through this, so a field
 * that is checked in Settings cannot be unchecked on the rail.
 */
export function parseAutomationFormValue(value: AutomationFormValue): ParseResult<{
  readonly name: AutomationName;
  readonly prompt: AutomationPrompt;
  readonly enabled: boolean;
  readonly cronExpression: AutomationCronExpression;
  readonly timeZone: AutomationTimeZone;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly concurrencyPolicy: AutomationConcurrencyPolicy;
}> {
  const textFields = parseAutomationTextFields(value.name, value.prompt);
  if (!textFields.ok) return textFields;
  const scheduleFields = parseAutomationScheduleFields(value.cronExpression, value.timeZone);
  if (!scheduleFields.ok) return scheduleFields;
  return {
    ok: true,
    value: {
      ...textFields.value,
      enabled: value.enabled,
      ...scheduleFields.value,
      modelSelection: value.modelSelection,
      runtimeMode: value.runtimeMode,
      interactionMode: value.interactionMode,
      concurrencyPolicy: value.concurrencyPolicy,
    },
  };
}

function summarizeText(value: string): { readonly preview: string; readonly length: number } {
  let preview = "";
  let length = 0;
  for (const character of value) {
    if (length < AUTOMATION_SUMMARY_PREVIEW_CODE_POINTS) preview += character;
    length += 1;
  }
  return { preview, length };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function toAutomationSummary(automation: ProjectAutomation): ProjectAutomationSummary {
  const prompt = summarizeText(automation.prompt);
  const model = summarizeText(automation.modelSelection.model);
  return {
    id: automation.id,
    projectId: automation.projectId,
    botId: automation.botId,
    name: automation.name,
    promptPreview: prompt.preview,
    promptLength: prompt.length,
    enabled: automation.enabled,
    cronExpression: automation.cronExpression,
    timeZone: automation.timeZone,
    modelInstanceId: automation.modelSelection.instanceId,
    modelPreview: model.preview,
    modelLength: model.length,
    runtimeMode: automation.runtimeMode,
    interactionMode: automation.interactionMode,
    concurrencyPolicy: automation.concurrencyPolicy,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

export function mergeAutomationSummaryPages(
  firstPage: ReadonlyArray<ProjectAutomationSummary>,
  additionalPages: ReadonlyArray<ProjectAutomationSummary>,
): ReadonlyArray<ProjectAutomationSummary> {
  const firstPageIds = new Set(firstPage.map((automation) => automation.id));
  return [
    ...firstPage,
    ...additionalPages.filter((automation) => !firstPageIds.has(automation.id)),
  ];
}

export function appendAutomationSummaryPage(
  current: ReadonlyArray<ProjectAutomationSummary>,
  page: ReadonlyArray<ProjectAutomationSummary>,
): ReadonlyArray<ProjectAutomationSummary> {
  const byId = new Map(current.map((automation) => [automation.id, automation]));
  for (const automation of page) byId.set(automation.id, automation);
  return [...byId.values()];
}

export function upsertAutomationSummary(
  current: ReadonlyArray<ProjectAutomationSummary>,
  automation: ProjectAutomation,
): ReadonlyArray<ProjectAutomationSummary> {
  const summary = toAutomationSummary(automation);
  const index = current.findIndex((candidate) => candidate.id === summary.id);
  if (index === -1) return [...current, summary];
  return current.map((candidate, candidateIndex) =>
    candidateIndex === index ? summary : candidate,
  );
}

export function removeAutomationSummary(
  current: ReadonlyArray<ProjectAutomationSummary>,
  automationId: ProjectAutomationSummary["id"],
): ReadonlyArray<ProjectAutomationSummary> {
  return current.filter((automation) => automation.id !== automationId);
}

export function reconcileAutomationRun(
  current: ReadonlyArray<ProjectAutomationSummary>,
  run: AutomationRun,
): ReadonlyArray<ProjectAutomationSummary> {
  if (run.startedAt === null) return current;
  return current.map((automation) =>
    automation.id === run.automationId ? { ...automation, lastRunAt: run.startedAt } : automation,
  );
}

export function isAutomationPromptTruncated(automation: ProjectAutomationSummary): boolean {
  return automation.promptLength > codePointLength(automation.promptPreview);
}

export function isAutomationModelTruncated(automation: ProjectAutomationSummary): boolean {
  return automation.modelLength > codePointLength(automation.modelPreview);
}

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
