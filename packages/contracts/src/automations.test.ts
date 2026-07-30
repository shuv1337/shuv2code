import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import {
  AutomationCreateInput,
  AutomationListInput,
  AutomationName,
  AutomationPrompt,
  AutomationRun,
} from "./automations.ts";

const decodeAutomationCreateInput = Schema.decodeUnknownSync(AutomationCreateInput);
const decodeAutomationListInput = Schema.decodeUnknownSync(AutomationListInput);
const decodeAutomationName = Schema.decodeUnknownSync(AutomationName);
const decodeAutomationPrompt = Schema.decodeUnknownSync(AutomationPrompt);
const decodeAutomationRun = Schema.decodeUnknownSync(AutomationRun);

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
