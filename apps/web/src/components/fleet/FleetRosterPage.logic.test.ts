import type { AdeRoster, AdeRosterEntry, Bot, BotId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getRosterRowView,
  getRosterRowViews,
  rosterNeedsFirstProject,
  templateOptionLabel,
} from "./FleetRosterPage.logic";

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot_1" as BotId,
    name: "Firstmate",
    displayMeta: null,
    structuralRole: "firstmate",
    roleTag: "Coordinator",
    projectId: null,
    activePersonaVersionId: null,
    computerUse: false,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  } as Bot;
}

function entry(overrides: Partial<AdeRosterEntry> = {}): AdeRosterEntry {
  return {
    bot: bot(),
    projectName: null,
    hasActivePrimarySession: false,
    openAssignmentCount: 0,
    ...overrides,
  } as AdeRosterEntry;
}

describe("getRosterRowView", () => {
  it("marks the Firstmate and names a fleet-wide bot's home", () => {
    const view = getRosterRowView(entry());
    expect(view.isFirstmate).toBe(true);
    expect(view.roleLabel).toBe("Firstmate");
    expect(view.projectLabel).toBe("Fleet-wide");
    expect(view.openAssignmentLabel).toBeNull();
    expect(view.chatLabel).toBe("Chat");
  });

  it("resumes rather than starts when a primary session is already warm", () => {
    expect(getRosterRowView(entry({ hasActivePrimarySession: true })).chatLabel).toBe(
      "Resume chat",
    );
  });

  it("counts open assignments in words the row can print", () => {
    expect(getRosterRowView(entry({ openAssignmentCount: 1 })).openAssignmentLabel).toBe(
      "1 open assignment",
    );
    expect(getRosterRowView(entry({ openAssignmentCount: 4 })).openAssignmentLabel).toBe(
      "4 open assignments",
    );
  });

  it("uses the project name when the bot has a home", () => {
    const view = getRosterRowView(
      entry({ bot: bot({ structuralRole: "crew", roleTag: "Coder" }), projectName: "shuv2code" }),
    );
    expect(view.projectLabel).toBe("shuv2code");
    expect(view.roleLabel).toBe("Crew");
    expect(view.isFirstmate).toBe(false);
  });
});

describe("getRosterRowViews", () => {
  it("preserves the server's order and reads nothing before the roster answers", () => {
    expect(getRosterRowViews(null)).toEqual([]);
    const roster = {
      entries: [entry(), entry({ bot: bot({ id: "bot_2" as BotId, name: "Coder" }) })],
      projects: [],
      templates: [],
    } as unknown as AdeRoster;
    expect(getRosterRowViews(roster).map((row) => row.name)).toEqual(["Firstmate", "Coder"]);
  });
});

describe("rosterNeedsFirstProject", () => {
  it("stays quiet until the roster has answered", () => {
    expect(rosterNeedsFirstProject(null)).toBe(false);
  });

  it("asks for a first project only when there is none", () => {
    expect(
      rosterNeedsFirstProject({ entries: [], projects: [], templates: [] } as unknown as AdeRoster),
    ).toBe(true);
    expect(
      rosterNeedsFirstProject({
        entries: [],
        projects: [{ id: "prj_1", name: "shuv2code" }],
        templates: [],
      } as unknown as AdeRoster),
    ).toBe(false);
  });
});

describe("templateOptionLabel", () => {
  it("prints the name alone when the role tag repeats it", () => {
    expect(
      templateOptionLabel({ templateId: "coder", defaultName: "Coder", roleTag: "Coder" } as never),
    ).toBe("Coder");
  });

  it("prints both when they differ", () => {
    expect(
      templateOptionLabel({
        templateId: "researcher",
        defaultName: "Scout",
        roleTag: "Researcher",
      } as never),
    ).toBe("Scout · Researcher");
  });
});
