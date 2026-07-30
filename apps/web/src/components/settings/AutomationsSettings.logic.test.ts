import { describe, expect, it } from "vite-plus/test";
import { AutomationRun, ProjectAutomation, ProjectAutomationSummary } from "@shuv2code/contracts";
import * as Schema from "effect/Schema";

import {
  appendAutomationSummaryPage,
  isAutomationModelTruncated,
  isAutomationPromptTruncated,
  mergeAutomationSummaryPages,
  parseAutomationScheduleFields,
  parseAutomationTextFields,
  reconcileAutomationRun,
  removeAutomationSummary,
  toAutomationSummary,
  upsertAutomationSummary,
} from "./AutomationsSettings.logic";

const decodeAutomation = Schema.decodeUnknownSync(ProjectAutomation);
const decodeAutomationRun = Schema.decodeUnknownSync(AutomationRun);
const decodeAutomationSummary = Schema.decodeUnknownSync(ProjectAutomationSummary);

function automationFixture(overrides: Readonly<Record<string, unknown>> = {}) {
  return decodeAutomation({
    id: "automation-1",
    projectId: "project-1",
    name: "Morning report",
    prompt: "Run the report",
    enabled: false,
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    concurrencyPolicy: "skip",
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  });
}

function summaryFixture(overrides: Readonly<Record<string, unknown>> = {}) {
  return decodeAutomationSummary({
    id: "automation-1",
    projectId: "project-1",
    name: "Morning report",
    promptPreview: "Run the report",
    promptLength: 14,
    enabled: false,
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
    ...overrides,
  });
}

describe("Automation settings form", () => {
  it("normalizes valid schedule fields", () => {
    expect(parseAutomationScheduleFields(" 0 9 * * 1-5 ", " Europe/London ")).toEqual({
      ok: true,
      value: { cronExpression: "0 9 * * 1-5", timeZone: "Europe/London" },
    });
  });

  it.each([
    ["", "Europe/London", "Enter a cron schedule."],
    ["0 9 * * *", "", "Enter a time zone."],
    ["x".repeat(161), "UTC", "Cron schedule must be 160 characters or less."],
    ["0 9 * * *", "x".repeat(129), "Time zone must be 128 characters or less."],
  ])("rejects invalid schedule fields without throwing", (cron, timeZone, error) => {
    expect(parseAutomationScheduleFields(cron, timeZone)).toEqual({ ok: false, error });
  });

  it("normalizes name and instructions", () => {
    expect(parseAutomationTextFields(" Morning report ", " Scan the feed ")).toEqual({
      ok: true,
      value: { name: "Morning report", prompt: "Scan the feed" },
    });
  });

  it.each([
    ["", "prompt", "Enter a name."],
    ["name", "", "Enter instructions."],
    ["x".repeat(161), "prompt", "Name must be 160 characters or less."],
    ["name", "x".repeat(120_001), "Instructions must be 120,000 characters or less."],
  ])("rejects invalid text fields without throwing", (name, prompt, error) => {
    expect(parseAutomationTextFields(name, prompt)).toEqual({ ok: false, error });
  });

  it("creates bounded local summaries without retaining model options", () => {
    const automation = automationFixture({
      prompt: "😀".repeat(121),
      modelSelection: {
        instanceId: "codex",
        model: "m".repeat(130),
        options: [{ id: "payload", value: "x".repeat(10_000) }],
      },
    });
    const summary = toAutomationSummary(automation);

    expect(Array.from(summary.promptPreview)).toHaveLength(120);
    expect(summary.promptLength).toBe(121);
    expect(summary.modelPreview).toBe("m".repeat(120));
    expect(summary.modelLength).toBe(130);
    expect(summary).not.toHaveProperty("modelSelection");
    expect(isAutomationPromptTruncated(summary)).toBe(true);
    expect(isAutomationModelTruncated(summary)).toBe(true);
  });

  it("prefers fresh first-page records while deduplicating loaded pages", () => {
    const fresh = summaryFixture({ enabled: true, updatedAt: "fresh" });
    const stale = summaryFixture({ enabled: false, updatedAt: "stale" });
    const second = summaryFixture({ id: "automation-2", name: "Second" });

    expect(mergeAutomationSummaryPages([fresh], [stale, second])).toEqual([fresh, second]);
    expect(
      appendAutomationSummaryPage(
        [fresh, second],
        [summaryFixture({ id: "automation-2", name: "Updated second" })],
      ),
    ).toEqual([fresh, summaryFixture({ id: "automation-2", name: "Updated second" })]);
  });

  it("reconciles loaded-page updates, runs, creation, and deletion", () => {
    const first = summaryFixture();
    const second = summaryFixture({ id: "automation-2", name: "Second" });
    const updatedSecond = automationFixture({
      id: "automation-2",
      name: "Updated second",
      enabled: true,
    });
    const created = automationFixture({ id: "automation-3", name: "Newly created" });

    let loaded = upsertAutomationSummary([first, second], updatedSecond);
    expect(loaded[1]?.name).toBe("Updated second");
    expect(loaded[1]?.enabled).toBe(true);

    loaded = reconcileAutomationRun(
      loaded,
      decodeAutomationRun({
        id: "run-1",
        automationId: "automation-2",
        projectId: "project-1",
        trigger: "manual",
        status: "running",
        threadId: "thread-1",
        scheduledFor: "2026-07-30T01:00:00.000Z",
        startedAt: "2026-07-30T01:00:01.000Z",
        completedAt: null,
        error: null,
      }),
    );
    expect(loaded[1]?.lastRunAt).toBe("2026-07-30T01:00:01.000Z");

    loaded = upsertAutomationSummary(loaded, created);
    expect(loaded.map((automation) => automation.id)).toContain("automation-3");

    loaded = removeAutomationSummary(loaded, second.id);
    expect(loaded.map((automation) => automation.id)).toEqual(["automation-1", "automation-3"]);
  });
});
