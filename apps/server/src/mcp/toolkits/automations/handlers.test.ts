import {
  AutomationId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@shuv2code/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import * as AutomationService from "../../../automations/AutomationService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  automationHandlers,
  normalizeAutomationCreateInput,
  requireAllowedAutomationRuntime,
} from "./handlers.ts";

const context = {
  projectId: ProjectId.make("project-1"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

describe("normalizeAutomationCreateInput", () => {
  it("defaults to paused, skips overlap, and inherits the current chat runtime", () => {
    expect(
      normalizeAutomationCreateInput(
        {
          name: "Daily report",
          prompt: "Create the report.",
          cronExpression: "0 9 * * *",
          timeZone: "Europe/London",
        },
        context,
      ),
    ).toEqual({
      projectId: context.projectId,
      name: "Daily report",
      prompt: "Create the report.",
      enabled: false,
      cronExpression: "0 9 * * *",
      timeZone: "Europe/London",
      modelSelection: context.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      concurrencyPolicy: "skip",
    });
  });

  it("preserves explicit activation, provider, runtime, interaction, and overlap choices", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "open-model",
    };
    expect(
      normalizeAutomationCreateInput(
        {
          name: "Parallel report",
          prompt: "Create the report in parallel.",
          enabled: true,
          cronExpression: "*/15 * * * *",
          timeZone: "UTC",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          concurrencyPolicy: "parallel",
        },
        context,
      ),
    ).toMatchObject({
      enabled: true,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      concurrencyPolicy: "parallel",
    });
  });
});

describe("automation MCP authority", () => {
  effectIt.effect("rejects broader child permissions", () =>
    Effect.gen(function* () {
      expect(
        yield* requireAllowedAutomationRuntime("approval-required", "full-access").pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "unauthorized" });
      expect(yield* requireAllowedAutomationRuntime("auto", "auto-accept-edits")).toBeUndefined();
    }),
  );

  effectIt.effect("rejects a missing capability before resolving or calling project services", () =>
    Effect.gen(function* () {
      const projectionCalls = yield* Ref.make(0);
      const serviceCalls = yield* Ref.make(0);
      const layer = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set<McpInvocationContext.McpCapability>(["preview"]),
          issuedAt: 1,
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById: () =>
            Ref.update(projectionCalls, (count) => count + 1).pipe(Effect.as(Option.none())),
        }),
        Layer.mock(AutomationService.AutomationService)({
          get: () =>
            Ref.update(serviceCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("service must not be called")),
            ),
        }),
      );

      const error = yield* automationHandlers
        .automation_get({ automationId: AutomationId.make("automation-1") })
        .pipe(Effect.provide(layer), Effect.flip);
      expect(error).toMatchObject({ reason: "unauthorized" });
      expect(yield* Ref.get(projectionCalls)).toBe(0);
      expect(yield* Ref.get(serviceCalls)).toBe(0);
    }),
  );

  effectIt.effect("derives the project from the invoking thread before delegating", () =>
    Effect.gen(function* () {
      const automationId = AutomationId.make("automation-1");
      const delegatedProject = yield* Ref.make<ProjectId | null>(null);
      const automation = {
        id: automationId,
        projectId: context.projectId,
        name: "Daily report",
        prompt: "Create the report.",
        enabled: false,
        cronExpression: "0 9 * * *",
        timeZone: "Europe/London",
        modelSelection: context.modelSelection,
        runtimeMode: context.runtimeMode,
        interactionMode: context.interactionMode,
        concurrencyPolicy: "skip" as const,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      };
      const layer = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set<McpInvocationContext.McpCapability>(["preview", "automations"]),
          issuedAt: 1,
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: ThreadId.make("thread-1"),
                projectId: context.projectId,
                title: "Current chat",
                modelSelection: context.modelSelection,
                runtimeMode: context.runtimeMode,
                interactionMode: context.interactionMode,
                branch: null,
                worktreePath: "/tmp/project-1",
                latestTurn: null,
                createdAt: "2026-07-30T00:00:00.000Z",
                updatedAt: "2026-07-30T00:00:00.000Z",
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                session: null,
                latestUserMessageAt: null,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                hasActionableProposedPlan: false,
              }),
            ),
        }),
        Layer.mock(AutomationService.AutomationService)({
          get: (input) =>
            Ref.set(delegatedProject, input.projectId ?? null).pipe(Effect.as(automation)),
        }),
      );

      const result = yield* automationHandlers
        .automation_get({ automationId })
        .pipe(Effect.provide(layer));
      expect(result.id).toBe(automationId);
      expect(yield* Ref.get(delegatedProject)).toBe(context.projectId);
    }),
  );

  effectIt.effect("rejects permission escalation while an automation is paused", () =>
    Effect.gen(function* () {
      const automationId = AutomationId.make("paused-automation");
      const updateCalls = yield* Ref.make(0);
      const automation = {
        id: automationId,
        projectId: context.projectId,
        name: "Paused report",
        prompt: "Create the report.",
        enabled: false,
        cronExpression: "0 9 * * *",
        timeZone: "Europe/London",
        modelSelection: context.modelSelection,
        runtimeMode: "approval-required" as const,
        interactionMode: context.interactionMode,
        concurrencyPolicy: "skip" as const,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      };
      const layer = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("approval-thread"),
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set<McpInvocationContext.McpCapability>(["preview", "automations"]),
          issuedAt: 1,
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: ThreadId.make("approval-thread"),
                projectId: context.projectId,
                title: "Approval-required chat",
                modelSelection: context.modelSelection,
                runtimeMode: "approval-required",
                interactionMode: context.interactionMode,
                branch: null,
                worktreePath: "/tmp/project-1",
                latestTurn: null,
                createdAt: "2026-07-30T00:00:00.000Z",
                updatedAt: "2026-07-30T00:00:00.000Z",
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                session: null,
                latestUserMessageAt: null,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                hasActionableProposedPlan: false,
              }),
            ),
        }),
        Layer.mock(AutomationService.AutomationService)({
          get: () => Effect.succeed(automation),
          update: () =>
            Ref.update(updateCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("update must not be called")),
            ),
        }),
      );

      const error = yield* automationHandlers
        .automation_update({ automationId, runtimeMode: "full-access" })
        .pipe(Effect.provide(layer), Effect.flip);
      expect(error).toMatchObject({ reason: "unauthorized" });
      expect(yield* Ref.get(updateCalls)).toBe(0);
    }),
  );
});
