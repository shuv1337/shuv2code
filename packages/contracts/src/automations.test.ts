import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import {
  AutomationCreateInput,
  AutomationListInput,
  AutomationListResult,
  AutomationName,
  AutomationPrompt,
  AutomationRun,
  ProjectAutomationSummary,
} from "./automations.ts";

const decodeAutomationCreateInput = Schema.decodeUnknownSync(AutomationCreateInput);
const decodeAutomationListInput = Schema.decodeUnknownSync(AutomationListInput);
const decodeAutomationListResult = Schema.decodeUnknownSync(AutomationListResult);
const decodeAutomationName = Schema.decodeUnknownSync(AutomationName);
const decodeAutomationPrompt = Schema.decodeUnknownSync(AutomationPrompt);
const decodeAutomationRun = Schema.decodeUnknownSync(AutomationRun);
const decodeProjectAutomationSummary = Schema.decodeUnknownSync(ProjectAutomationSummary);

const automationSummary = {
  id: "automation-1",
  projectId: "project-1",
  name: "Morning report",
  promptPreview: "Run the report",
  promptLength: 14,
  enabled: true,
  cronExpression: "0 9 * * *",
  timeZone: "UTC",
  modelInstanceId: "codex",
  modelPreview: "gpt-5.6-sol",
  modelLength: 11,
  runtimeMode: "full-access",
  interactionMode: "default",
  concurrencyPolicy: "skip",
  nextRunAt: null,
  lastRunAt: null,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
} as const;

it("decodes a complete project automation create input", () => {
  const decoded = decodeAutomationCreateInput({
    projectId: "project-1",
    name: "Morning report",
    prompt: "Run the report",
    enabled: true,
    cronExpression: "0 9 * * *",
    timeZone: "Europe/London",
    modelSelection: {
      instanceId: "opencode",
      model: "anthropic/claude-sonnet-4-5",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    concurrencyPolicy: "skip",
  });

  assert.strictEqual(decoded.name, "Morning report");
  assert.strictEqual(decoded.cronExpression, "0 9 * * *");
  assert.strictEqual(decoded.modelSelection.instanceId, "opencode");
  assert.strictEqual(decoded.modelSelection.model, "anthropic/claude-sonnet-4-5");
  assert.deepStrictEqual(decoded.modelSelection.options, [
    { id: "reasoningEffort", value: "high" },
  ]);
});

it("preserves custom provider instance routing", () => {
  const decoded = decodeAutomationCreateInput({
    projectId: "project-1",
    name: "Work account report",
    prompt: "Run the report",
    enabled: false,
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    modelSelection: { instanceId: "codex_work", model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    concurrencyPolicy: "parallel",
  });

  assert.strictEqual(decoded.modelSelection.instanceId, "codex_work");
  assert.strictEqual(decoded.runtimeMode, "approval-required");
  assert.strictEqual(decoded.interactionMode, "plan");
  assert.strictEqual(decoded.concurrencyPolicy, "parallel");
});

it("rejects blank names and prompts", () => {
  assert.throws(() => decodeAutomationName("  "));
  assert.throws(() => decodeAutomationPrompt("\n\t"));
});

it("decodes linked run history", () => {
  const decoded = decodeAutomationRun({
    id: "run-1",
    automationId: "automation-1",
    projectId: "project-1",
    trigger: "scheduled",
    status: "running",
    threadId: "thread-1",
    scheduledFor: "2026-07-30T08:00:00.000Z",
    startedAt: "2026-07-30T08:00:01.000Z",
    completedAt: null,
    error: null,
  });

  assert.strictEqual(decoded.threadId, "thread-1");
});

it("bounds automation list pages at one hundred summaries", () => {
  const accepted = decodeAutomationListInput({ projectId: "project-1", limit: 100 });
  assert.strictEqual(accepted.limit, 100);
  assert.throws(() => decodeAutomationListInput({ projectId: "project-1", limit: 101 }));

  const page = decodeAutomationListResult({
    automations: Array.from({ length: 100 }, (_, index) => ({
      ...automationSummary,
      id: `automation-${index}`,
    })),
    nextCursor: "next-page",
  });
  assert.strictEqual(page.automations.length, 100);
  assert.throws(() =>
    decodeAutomationListResult({
      automations: Array.from({ length: 101 }, (_, index) => ({
        ...automationSummary,
        id: `automation-${index}`,
      })),
      nextCursor: null,
    }),
  );
});

it("decodes automation list cursors and enabled-state filters", () => {
  const decoded = decodeAutomationListInput({
    projectId: "project-1",
    cursor: "opaque-page-token",
    enabled: false,
    limit: 20,
  });
  assert.strictEqual(decoded.cursor, "opaque-page-token");
  assert.strictEqual(decoded.enabled, false);
});

it("keeps automation summary model metadata bounded and option-free", () => {
  const decoded = decodeProjectAutomationSummary(automationSummary);
  assert.strictEqual(decoded.modelInstanceId, "codex");
  assert.strictEqual(decoded.modelPreview, "gpt-5.6-sol");
  assert.ok(!("modelSelection" in decoded));
  assert.throws(() =>
    decodeProjectAutomationSummary({
      ...automationSummary,
      modelPreview: "x".repeat(241),
    }),
  );
});
