import {
  AutomationError,
  type AutomationCreateInput as ServiceCreateInput,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as AutomationService from "../../../automations/AutomationService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  AutomationToolkit,
  type AutomationCreateInput,
  type AutomationUpdateInput,
} from "./tools.ts";

const projectionFailure = (cause: { readonly message: string }) =>
  new AutomationError({ reason: "persistence_failed", message: cause.message });

const requireAutomationCapability = McpInvocationContext.requireMcpCapability("automations").pipe(
  Effect.mapError(
    () =>
      new AutomationError({
        reason: "unauthorized",
        message: "This agent session is not allowed to manage project automations.",
      }),
  ),
);

const normalizeModelSelection = (selection: NonNullable<AutomationCreateInput["modelSelection"]>) =>
  selection.options === undefined
    ? { instanceId: selection.instanceId, model: selection.model }
    : { instanceId: selection.instanceId, model: selection.model, options: selection.options };

export const resolveCurrentAutomationContext = Effect.fn("AutomationToolkit.resolveCurrentContext")(
  function* () {
    const invocation = yield* requireAutomationCapability;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    return yield* snapshots.getThreadShellById(invocation.threadId).pipe(
      Effect.mapError(projectionFailure),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new AutomationError({
                reason: "project_not_found",
                message: "The current chat is not attached to an active project.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  },
);

export const normalizeAutomationCreateInput = (
  input: AutomationCreateInput,
  context: {
    readonly projectId: ServiceCreateInput["projectId"];
    readonly modelSelection: ServiceCreateInput["modelSelection"];
    readonly runtimeMode: ServiceCreateInput["runtimeMode"];
    readonly interactionMode: ServiceCreateInput["interactionMode"];
  },
): ServiceCreateInput => ({
  projectId: context.projectId,
  name: input.name,
  prompt: input.prompt,
  enabled: input.enabled ?? false,
  cronExpression: input.cronExpression,
  timeZone: input.timeZone,
  modelSelection:
    input.modelSelection === undefined
      ? context.modelSelection
      : normalizeModelSelection(input.modelSelection),
  runtimeMode: input.runtimeMode ?? context.runtimeMode,
  interactionMode: input.interactionMode ?? context.interactionMode,
  concurrencyPolicy: input.concurrencyPolicy ?? "skip",
});

const handlers = {
  automation_list: (input) =>
    Effect.gen(function* () {
      const context = yield* resolveCurrentAutomationContext();
      const service = yield* AutomationService.AutomationService;
      const result = yield* service.list({ projectId: context.projectId });
      return input.enabled === undefined
        ? result
        : {
            automations: result.automations.filter(
              (automation) => automation.enabled === input.enabled,
            ),
          };
    }),
  automation_get: (input) =>
    Effect.gen(function* () {
      const context = yield* resolveCurrentAutomationContext();
      const service = yield* AutomationService.AutomationService;
      return yield* service.get({ projectId: context.projectId, automationId: input.automationId });
    }),
  automation_create: (input) =>
    Effect.gen(function* () {
      const context = yield* resolveCurrentAutomationContext();
      const service = yield* AutomationService.AutomationService;
      return yield* service.create(normalizeAutomationCreateInput(input, context));
    }),
  automation_update: (input: AutomationUpdateInput) =>
    Effect.gen(function* () {
      const context = yield* resolveCurrentAutomationContext();
      const service = yield* AutomationService.AutomationService;
      const { modelSelection, ...updates } = input;
      return yield* service.update({
        ...updates,
        ...(modelSelection === undefined
          ? {}
          : { modelSelection: normalizeModelSelection(modelSelection) }),
        projectId: context.projectId,
      });
    }),
  automation_delete: (input) =>
    Effect.gen(function* () {
      const context = yield* resolveCurrentAutomationContext();
      const service = yield* AutomationService.AutomationService;
      return yield* service.delete({
        projectId: context.projectId,
        automationId: input.automationId,
      });
    }),
  automation_run_now: (input) =>
    Effect.gen(function* () {
      const context = yield* resolveCurrentAutomationContext();
      const service = yield* AutomationService.AutomationService;
      return yield* service.runNow({
        projectId: context.projectId,
        automationId: input.automationId,
      });
    }),
  automation_list_runs: (input) =>
    Effect.gen(function* () {
      const context = yield* resolveCurrentAutomationContext();
      const service = yield* AutomationService.AutomationService;
      return yield* service.listRuns({
        projectId: context.projectId,
        automationId: input.automationId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    }),
  automation_validate_schedule: (input) =>
    Effect.gen(function* () {
      yield* requireAutomationCapability;
      const service = yield* AutomationService.AutomationService;
      return yield* service.validateSchedule(input);
    }),
} satisfies Parameters<typeof AutomationToolkit.toLayer>[0];

export const AutomationToolkitHandlersLive = AutomationToolkit.toLayer(handlers);
