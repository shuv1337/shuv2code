import {
  AutomationConcurrencyPolicy,
  AutomationError,
  AutomationListResult,
  AutomationRun,
  AutomationListRunsResult,
  AutomationValidationResult,
  PositiveInt,
  ProviderInteractionMode,
  ProviderOptionSelections,
  RuntimeMode,
  ProjectAutomation,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as AutomationService from "../../../automations/AutomationService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  AutomationService.AutomationService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

const describedTrimmedString = (description: string) =>
  Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value.trim()),
        encode: (value) => Effect.succeed(value.trim()),
      }),
    ),
    Schema.check(Schema.isNonEmpty()),
  );

const AutomationIdInput = describedTrimmedString(
  "Exact automation ID returned by automation_list or automation_create.",
).pipe(Schema.brand("AutomationId"));
const AutomationNameInput = describedTrimmedString(
  "Short human-readable name for the automation and its generated threads.",
).check(Schema.isMaxLength(160));
const AutomationPromptInput = describedTrimmedString(
  "Complete unattended task instructions. This text becomes the first user message in every generated thread.",
).check(Schema.isMaxLength(120_000));
const AutomationCronExpressionInput = describedTrimmedString(
  "Five-field cron expression, for example '0 9 * * 1-5' for 09:00 Monday-Friday.",
).check(Schema.isMaxLength(160));
const AutomationTimeZoneInput = describedTrimmedString(
  "IANA time zone used to evaluate the cron schedule, for example Europe/London.",
).check(Schema.isMaxLength(128));
const ProviderInstanceIdInput = describedTrimmedString(
  "Configured provider instance ID, for example codex, claude, or an OpenCode instance.",
).pipe(Schema.brand("ProviderInstanceId"));
const ModelNameInput = describedTrimmedString(
  "Provider model identifier for generated automation threads.",
);

const AutomationTargetInput = Schema.Struct({
  automationId: AutomationIdInput,
});

export const AutomationListInput = Schema.Struct({
  enabled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Optional enabled-state filter. Omit to return both active and paused automations.",
    }),
  ).annotate({
    description:
      "Optional enabled-state filter. Omit to return both active and paused automations.",
  }),
});

const AutomationModelSelectionInput = Schema.Struct({
  instanceId: ProviderInstanceIdInput,
  model: ModelNameInput,
  options: Schema.optional(
    ProviderOptionSelections.annotate({
      description: "Optional provider-specific model settings.",
    }),
  ).annotate({ description: "Optional provider-specific model settings." }),
});

export const AutomationListTool = Tool.make("automation_list", {
  description:
    "List the scheduled automations owned by this chat's current project. Returns complete configuration, enabled state, next-run time, and identifiers for follow-up actions.",
  parameters: AutomationListInput,
  success: AutomationListResult,
  failure: AutomationError,
  dependencies,
})
  .annotate(Tool.Title, "List project automations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AutomationGetTool = Tool.make("automation_get", {
  description:
    "Get one scheduled automation from this chat's current project by its exact ID, including prompt, schedule, model, permissions, and current enabled state.",
  parameters: AutomationTargetInput,
  success: ProjectAutomation,
  failure: AutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Get project automation")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AutomationCreateInput = Schema.Struct({
  name: AutomationNameInput,
  prompt: AutomationPromptInput,
  cronExpression: AutomationCronExpressionInput,
  timeZone: AutomationTimeZoneInput,
  enabled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Whether scheduled execution is active. Defaults to false; set true only when the user explicitly asks to activate the schedule.",
    }),
  ).annotate({
    description:
      "Whether scheduled execution is active. Defaults to false; set true only when the user explicitly asks to activate the schedule.",
  }),
  modelSelection: Schema.optional(
    AutomationModelSelectionInput.annotate({
      description:
        "Provider instance and model for generated threads. Omit to inherit this chat's provider and model.",
    }),
  ).annotate({
    description:
      "Provider instance and model for generated threads. Omit to inherit this chat's provider and model.",
  }),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({
      description:
        "Permission mode for generated threads. Omit to inherit this chat's current permission mode.",
    }),
  ).annotate({
    description:
      "Permission mode for generated threads. Omit to inherit this chat's current permission mode.",
  }),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({
      description:
        "Agent interaction mode for generated threads. Omit to inherit this chat's mode.",
    }),
  ).annotate({
    description: "Agent interaction mode for generated threads. Omit to inherit this chat's mode.",
  }),
  concurrencyPolicy: Schema.optional(
    AutomationConcurrencyPolicy.annotate({
      description:
        "What to do when an earlier run is still active: skip the overlap or run in parallel. Defaults to skip.",
    }),
  ).annotate({
    description:
      "What to do when an earlier run is still active: skip the overlap or run in parallel. Defaults to skip.",
  }),
});
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

export const AutomationCreateTool = Tool.make("automation_create", {
  description:
    "Create a durable scheduled automation for this chat's current project. Creation defaults to paused and inherits this chat's model and permissions unless explicitly overridden.",
  parameters: AutomationCreateInput,
  success: ProjectAutomation,
  failure: AutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Create project automation")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const AutomationUpdateInput = Schema.Struct({
  automationId: AutomationIdInput,
  name: Schema.optional(AutomationNameInput).annotate({
    description: "Replacement human-readable name.",
  }),
  prompt: Schema.optional(AutomationPromptInput).annotate({
    description: "Replacement unattended task instructions.",
  }),
  enabled: Schema.optional(
    Schema.Boolean.annotate({
      description: "Set true to activate scheduled execution or false to pause it.",
    }),
  ).annotate({ description: "Set true to activate scheduled execution or false to pause it." }),
  cronExpression: Schema.optional(AutomationCronExpressionInput).annotate({
    description: "Replacement five-field cron expression.",
  }),
  timeZone: Schema.optional(AutomationTimeZoneInput).annotate({
    description: "Replacement IANA time zone.",
  }),
  modelSelection: Schema.optional(
    AutomationModelSelectionInput.annotate({
      description: "Replacement provider instance and model.",
    }),
  ).annotate({ description: "Replacement provider instance and model." }),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({ description: "Replacement permission mode for generated threads." }),
  ).annotate({ description: "Replacement permission mode for generated threads." }),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({ description: "Replacement agent interaction mode." }),
  ).annotate({ description: "Replacement agent interaction mode." }),
  concurrencyPolicy: Schema.optional(
    AutomationConcurrencyPolicy.annotate({ description: "Replacement overlap policy." }),
  ).annotate({ description: "Replacement overlap policy." }),
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationUpdateTool = Tool.make("automation_update", {
  description:
    "Update an automation owned by this chat's current project. Use enabled=true to activate scheduling and enabled=false to pause it; omitted fields remain unchanged.",
  parameters: AutomationUpdateInput,
  success: ProjectAutomation,
  failure: AutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Update project automation")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const AutomationDeleteTool = Tool.make("automation_delete", {
  description:
    "Permanently delete an automation owned by this chat's current project. Call only when the user explicitly asks to delete it; active runs prevent deletion.",
  parameters: AutomationTargetInput,
  success: Schema.Struct({ deleted: Schema.Boolean }),
  failure: AutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Delete project automation")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const AutomationRunNowTool = Tool.make("automation_run_now", {
  description:
    "Start one manual run of an automation in this chat's current project, even when its schedule is paused. Returns the run and generated thread ID for immediate follow-up.",
  parameters: AutomationTargetInput,
  success: AutomationRun,
  failure: AutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Run project automation now")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Idempotent, false);

export const AutomationListRunsInput = Schema.Struct({
  automationId: AutomationIdInput,
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(200)).annotate({
      description: "Maximum recent runs to return. Defaults to 50 and must not exceed 200.",
    }),
  ).annotate({
    description: "Maximum recent runs to return. Defaults to 50 and must not exceed 200.",
  }),
});

export const AutomationListRunsTool = Tool.make("automation_list_runs", {
  description:
    "List recent run history for one automation in this chat's current project, including trigger, status, timestamps, errors, and generated thread IDs.",
  parameters: AutomationListRunsInput,
  success: AutomationListRunsResult,
  failure: AutomationError,
  dependencies,
})
  .annotate(Tool.Title, "List automation runs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AutomationValidateScheduleInput = Schema.Struct({
  cronExpression: AutomationCronExpressionInput,
  timeZone: AutomationTimeZoneInput,
});

export const AutomationValidateScheduleTool = Tool.make("automation_validate_schedule", {
  description:
    "Validate a five-field cron schedule and IANA time zone without changing state. Returns whether it is valid and the next scheduled occurrence.",
  parameters: AutomationValidateScheduleInput,
  success: AutomationValidationResult,
  failure: AutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Validate automation schedule")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AutomationToolkit = Toolkit.make(
  AutomationListTool,
  AutomationGetTool,
  AutomationCreateTool,
  AutomationUpdateTool,
  AutomationDeleteTool,
  AutomationRunNowTool,
  AutomationListRunsTool,
  AutomationValidateScheduleTool,
);
