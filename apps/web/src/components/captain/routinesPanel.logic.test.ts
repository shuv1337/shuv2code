import type { AdeBotRoutineContext, BotId, ProjectAutomationSummary } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canCreateRoutine,
  getRoutineRowViews,
  routinesEmptyState,
  routinesSummaryLabel,
} from "./routinesPanel.logic";

const BOT = "bot-1" as BotId;
const OTHER = "bot-2" as BotId;

const context = (overrides: Partial<AdeBotRoutineContext> = {}): AdeBotRoutineContext =>
  ({
    botId: BOT,
    projectId: null,
    projectName: null,
    reason: "no-project",
    ...overrides,
  }) as AdeBotRoutineContext;

const automation = (
  id: string,
  overrides: Partial<ProjectAutomationSummary> = {},
): ProjectAutomationSummary =>
  ({
    id,
    projectId: "project-1",
    botId: null,
    name: id,
    promptPreview: "Do the thing",
    promptLength: 12,
    enabled: false,
    cronExpression: "0 9 * * 1-5",
    timeZone: "Europe/London",
    modelInstanceId: "instance-1",
    modelPreview: "gpt",
    modelLength: 3,
    runtimeMode: "full-access",
    interactionMode: "default",
    concurrencyPolicy: "skip",
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  }) as ProjectAutomationSummary;

describe("routinesEmptyState", () => {
  it("is absent once the context resolves", () => {
    expect(routinesEmptyState(context({ reason: "ready", projectId: "p" as never }))).toBe(null);
  });

  it("names a different remedy for each way the resolution can fail", () => {
    // The reason exists so the rail never tells a captain to bind a repo to a
    // project that does not exist — the #212 failure, one surface over.
    const noProject = routinesEmptyState(context({ reason: "no-project" }));
    const noRepo = routinesEmptyState(context({ reason: "no-repo-binding" }));
    const noWorkspace = routinesEmptyState(context({ reason: "no-workspace-project" }));
    expect(noProject?.detail).toContain("Create one");
    expect(noRepo?.detail).toContain("repository path");
    expect(noWorkspace?.detail).toContain("Send this bot a message");
    expect(new Set([noProject?.detail, noRepo?.detail, noWorkspace?.detail]).size).toBe(3);
  });

  it("addresses the remedy to the named project when there is one", () => {
    const state = routinesEmptyState(
      context({ reason: "no-repo-binding", projectName: "Ledger" as never }),
    );
    expect(state?.detail).toContain('"Ledger"');
    expect(state?.detail).not.toContain("this bot's project");
  });

  it("names the project in every reason that has one to name", () => {
    // Pinned per reason rather than by a shared substring rewrite: the naming
    // used to be a `String.replace` of one sentence into another, which fails
    // *silently* the moment either sentence is reworded.
    const noWorkspace = routinesEmptyState(
      context({ reason: "no-workspace-project", projectName: "Ledger" as never }),
    );
    expect(noWorkspace?.detail).toContain('"Ledger"');
    expect(noWorkspace?.detail).not.toContain("its workspace,");
  });

  it("falls back to a sayable sentence when the project has no name", () => {
    for (const reason of ["no-repo-binding", "no-workspace-project"] as const) {
      const state = routinesEmptyState(context({ reason, projectName: null }));
      expect(state?.detail).not.toContain('""');
      expect(state?.detail).not.toContain("null");
      expect(state?.detail.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("does not name a project in the state that means there is no project", () => {
    // `projectName` can be non-null here only as a leftover; naming it would
    // claim a project the captain cannot open.
    const state = routinesEmptyState(
      context({ reason: "no-project", projectName: "Ledger" as never }),
    );
    expect(state?.detail).not.toContain("Ledger");
  });
});

describe("canCreateRoutine", () => {
  it("requires a resolved workspace project", () => {
    expect(canCreateRoutine(null, true)).toBe(false);
    expect(canCreateRoutine(context({ reason: "no-repo-binding" }), true)).toBe(false);
    // Defensive: `ready` without an id would be a server bug, and offering
    // Create against it would fail at submit instead of at render.
    expect(canCreateRoutine(context({ reason: "ready", projectId: null }), true)).toBe(false);
    expect(canCreateRoutine(context({ reason: "ready", projectId: "p" as never }), true)).toBe(
      true,
    );
  });

  it("also requires the shell's project, which the form needs and the RPC does not answer", () => {
    // D4: the button asked the RPC, the form asked the orchestration shell.
    // When they disagreed the button enabled and rendered nothing at all — a
    // pressed control with no visible consequence, which reads as a broken app
    // rather than as a wait.
    expect(canCreateRoutine(context({ reason: "ready", projectId: "p" as never }), false)).toBe(
      false,
    );
  });
});

describe("getRoutineRowViews", () => {
  it("puts the bot's own routines above the project's, preserving server order within each", () => {
    const rows = getRoutineRowViews({
      automations: [
        automation("shared-a"),
        automation("mine-a", { botId: BOT }),
        automation("shared-b"),
        automation("mine-b", { botId: BOT }),
      ],
      botId: BOT,
    });
    expect(rows.map((row) => row.id)).toEqual(["mine-a", "mine-b", "shared-a", "shared-b"]);
  });

  it("labels only the rows that are not this bot's", () => {
    const rows = getRoutineRowViews({
      automations: [automation("mine", { botId: BOT }), automation("shared")],
      botId: BOT,
    });
    expect(rows[0]?.ownedByBot).toBe(true);
    expect(rows[0]?.scopeLabel).toBe(null);
    expect(rows[1]?.ownedByBot).toBe(false);
    expect(rows[1]?.scopeLabel).toBe("Project");
  });

  it("treats another bot's attribution as project-wide rather than as this bot's", () => {
    // The server's filter should not return these, but the rail must not claim
    // a routine belongs to the open bot just because a row reached it.
    const rows = getRoutineRowViews({
      automations: [automation("theirs", { botId: OTHER })],
      botId: BOT,
    });
    expect(rows[0]?.ownedByBot).toBe(false);
  });

  it("carries the schedule the captain needs to recognise the row", () => {
    const rows = getRoutineRowViews({ automations: [automation("mine")], botId: BOT });
    expect(rows[0]?.schedule).toBe("0 9 * * 1-5 · Europe/London");
  });
});

describe("routinesSummaryLabel", () => {
  const rows = (own: number, shared: number) =>
    getRoutineRowViews({
      automations: [
        ...Array.from({ length: own }, (_, index) => automation(`mine-${index}`, { botId: BOT })),
        ...Array.from({ length: shared }, (_, index) => automation(`shared-${index}`)),
      ],
      botId: BOT,
    });

  it("says so when there is nothing", () => {
    expect(routinesSummaryLabel(rows(0, 0))).toBe("No routines yet");
  });

  it("counts from the bot's side and separates what it shares with the project", () => {
    expect(routinesSummaryLabel(rows(1, 0))).toBe("1 routine");
    expect(routinesSummaryLabel(rows(2, 1))).toBe("3 routines, 1 shared with the project");
  });
});
