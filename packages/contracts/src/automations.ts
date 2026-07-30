import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const entityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const AutomationId = entityId("AutomationId");
export type AutomationId = typeof AutomationId.Type;

export const AutomationRunId = entityId("AutomationRunId");
export type AutomationRunId = typeof AutomationRunId.Type;

export const AutomationName = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export type AutomationName = typeof AutomationName.Type;

export const AutomationPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
export type AutomationPrompt = typeof AutomationPrompt.Type;

export const AutomationCronExpression = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export type AutomationCronExpression = typeof AutomationCronExpression.Type;

export const AutomationTimeZone = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type AutomationTimeZone = typeof AutomationTimeZone.Type;

export const AutomationConcurrencyPolicy = Schema.Literals(["skip", "parallel"]);
export type AutomationConcurrencyPolicy = typeof AutomationConcurrencyPolicy.Type;

export const AutomationRunTrigger = Schema.Literals(["scheduled", "manual"]);
export type AutomationRunTrigger = typeof AutomationRunTrigger.Type;

export const AutomationRunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const ProjectAutomation = Schema.Struct({
  id: AutomationId,
  projectId: ProjectId,
  name: AutomationName,
  prompt: AutomationPrompt,
  enabled: Schema.Boolean,
  cronExpression: AutomationCronExpression,
  timeZone: AutomationTimeZone,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  concurrencyPolicy: AutomationConcurrencyPolicy,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectAutomation = typeof ProjectAutomation.Type;

export const AUTOMATION_SUMMARY_PREVIEW_CODE_POINTS = 120;
const AUTOMATION_SUMMARY_PREVIEW_MAX_CODE_UNITS = AUTOMATION_SUMMARY_PREVIEW_CODE_POINTS * 2;

export const AutomationPromptPreview = Schema.String.check(
  Schema.isMaxLength(AUTOMATION_SUMMARY_PREVIEW_MAX_CODE_UNITS),
);
export type AutomationPromptPreview = typeof AutomationPromptPreview.Type;

export const AutomationModelPreview = Schema.String.check(
  Schema.isMaxLength(AUTOMATION_SUMMARY_PREVIEW_MAX_CODE_UNITS),
);
export type AutomationModelPreview = typeof AutomationModelPreview.Type;

export const ProjectAutomationSummary = Schema.Struct({
  id: AutomationId,
  projectId: ProjectId,
  name: AutomationName,
  promptPreview: AutomationPromptPreview,
  promptLength: NonNegativeInt,
  enabled: Schema.Boolean,
  cronExpression: AutomationCronExpression,
  timeZone: AutomationTimeZone,
  modelInstanceId: ProviderInstanceId,
  modelPreview: AutomationModelPreview,
  modelLength: NonNegativeInt,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  concurrencyPolicy: AutomationConcurrencyPolicy,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectAutomationSummary = typeof ProjectAutomationSummary.Type;

export const AutomationRun = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  projectId: ProjectId,
  trigger: AutomationRunTrigger,
  status: AutomationRunStatus,
  threadId: Schema.NullOr(ThreadId),
  scheduledFor: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type AutomationRun = typeof AutomationRun.Type;

export const AutomationListCursor = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export type AutomationListCursor = typeof AutomationListCursor.Type;

export const AutomationListLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100));
export type AutomationListLimit = typeof AutomationListLimit.Type;

export const AutomationListInput = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(AutomationListCursor),
  limit: Schema.optional(AutomationListLimit),
});
export type AutomationListInput = typeof AutomationListInput.Type;

export const AutomationListResult = Schema.Struct({
  automations: Schema.Array(ProjectAutomationSummary).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(AutomationListCursor),
});
export type AutomationListResult = typeof AutomationListResult.Type;

export const AutomationGetInput = Schema.Struct({
  projectId: ProjectId,
  automationId: AutomationId,
});
export type AutomationGetInput = typeof AutomationGetInput.Type;

export const AutomationCreateInput = Schema.Struct({
  projectId: ProjectId,
  name: AutomationName,
  prompt: AutomationPrompt,
  enabled: Schema.Boolean,
  cronExpression: AutomationCronExpression,
  timeZone: AutomationTimeZone,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  concurrencyPolicy: AutomationConcurrencyPolicy,
});
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

export const AutomationUpdateInput = Schema.Struct({
  projectId: ProjectId,
  automationId: AutomationId,
  name: Schema.optional(AutomationName),
  prompt: Schema.optional(AutomationPrompt),
  enabled: Schema.optional(Schema.Boolean),
  cronExpression: Schema.optional(AutomationCronExpression),
  timeZone: Schema.optional(AutomationTimeZone),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  concurrencyPolicy: Schema.optional(AutomationConcurrencyPolicy),
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationDeleteInput = Schema.Struct({
  projectId: ProjectId,
  automationId: AutomationId,
});
export type AutomationDeleteInput = typeof AutomationDeleteInput.Type;

export const AutomationRunNowInput = Schema.Struct({
  projectId: ProjectId,
  automationId: AutomationId,
});
export type AutomationRunNowInput = typeof AutomationRunNowInput.Type;

export const AutomationListRunsInput = Schema.Struct({
  projectId: ProjectId,
  automationId: AutomationId,
  limit: Schema.optional(PositiveInt),
});
export type AutomationListRunsInput = typeof AutomationListRunsInput.Type;

export const AutomationListRunsResult = Schema.Struct({
  runs: Schema.Array(AutomationRun),
});
export type AutomationListRunsResult = typeof AutomationListRunsResult.Type;

export const AutomationDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type AutomationDeleteResult = typeof AutomationDeleteResult.Type;

export const AutomationValidationResult = Schema.Struct({
  valid: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type AutomationValidationResult = typeof AutomationValidationResult.Type;

export const AutomationValidateScheduleInput = Schema.Struct({
  cronExpression: AutomationCronExpression,
  timeZone: AutomationTimeZone,
});
export type AutomationValidateScheduleInput = typeof AutomationValidateScheduleInput.Type;

export const AutomationRunLimit = NonNegativeInt.check(Schema.isLessThanOrEqualTo(200));

export class AutomationError extends Schema.TaggedErrorClass<AutomationError>()("AutomationError", {
  reason: Schema.Literals([
    "not_found",
    "project_not_found",
    "invalid_schedule",
    "conflict",
    "persistence_failed",
    "dispatch_failed",
    "unauthorized",
    "invalid_cursor",
  ]),
  message: Schema.String,
}) {}
