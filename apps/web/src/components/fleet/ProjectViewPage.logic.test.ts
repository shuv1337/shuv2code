import type {
  AdeProjectCrewMember,
  AdeProjectDetail,
  AdePublicationStackView,
  Bot,
  BotId,
  IntegrationCandidate,
  PublicationLayer,
} from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  candidateStatusCounts,
  getCandidateRowViews,
  getProjectCrewRowViews,
  getProjectHeaderView,
  getPublicationStackView,
  isProjectNotFound,
  queueHeadId,
  unreadableRowsLabel,
} from "./ProjectViewPage.logic";

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot_1" as BotId,
    name: "Second Mate",
    displayMeta: null,
    structuralRole: "second-mate",
    roleTag: "Coordinator",
    projectId: "project_1",
    activePersonaVersionId: null,
    computerUse: false,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  } as Bot;
}

function member(overrides: Partial<AdeProjectCrewMember> = {}): AdeProjectCrewMember {
  return {
    bot: bot(),
    isSecondMate: true,
    hasActivePrimarySession: false,
    openAssignmentCount: 0,
    ...overrides,
  } as AdeProjectCrewMember;
}

function detail(overrides: Partial<AdeProjectDetail["project"]> = {}): AdeProjectDetail {
  return {
    project: {
      id: "project_1",
      name: "Demo",
      secondMateBotId: "bot_1",
      repoBinding: { path: "/repos/demo", remote: null },
      integrationPolicyDefault: "agent-review",
      checkCommands: ["vp check"],
      sharedSpecialistAllowList: "all",
      limitsOverrides: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      ...overrides,
    },
    crew: [member()],
  } as unknown as AdeProjectDetail;
}

function candidate(overrides: Partial<IntegrationCandidate> = {}): IntegrationCandidate {
  return {
    id: "cand_1",
    projectId: "project_1",
    idempotencyKey: "key",
    sourceAssignmentIds: [],
    changeIds: ["kmnopqrs"],
    originatingBotId: "bot_1",
    declaredRisk: "normal",
    status: "queued",
    gate: null,
    reviewerBotId: null,
    workspacePath: null,
    verdict: null,
    verdictAt: null,
    verdictByBotId: null,
    verdictDetail: null,
    bounceCount: 0,
    bounce: null,
    repairAssignmentId: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  } as unknown as IntegrationCandidate;
}

function layer(overrides: Record<string, unknown> = {}): PublicationLayer {
  return {
    id: "layer_1",
    stackId: "stack_1",
    order: 0,
    changeIds: ["kmnopqrs"],
    bookmarkName: "ade/layer-1",
    prNumber: 41,
    headSha: "abcdef1234",
    submittedSha: null,
    mergeSha: null,
    prState: "open",
    status: "submitted",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  } as unknown as PublicationLayer;
}

describe("crew panel", () => {
  it("marks the Second Mate and counts open work in words", () => {
    const rows = getProjectCrewRowViews({
      ...detail(),
      crew: [
        member(),
        member({
          bot: bot({ id: "bot_2" as BotId, name: "Coder", structuralRole: "crew" }),
          isSecondMate: false,
          openAssignmentCount: 2,
          hasActivePrimarySession: true,
        }),
      ],
    } as AdeProjectDetail);

    expect(rows[0]?.isSecondMate).toBe(true);
    expect(rows[0]?.roleLabel).toBe("Second Mate");
    expect(rows[0]?.openAssignmentLabel).toBeNull();
    expect(rows[0]?.chatLabel).toBe("Chat");
    expect(rows[1]?.openAssignmentLabel).toBe("2 open assignments");
    expect(rows[1]?.chatLabel).toBe("Resume chat");
  });

  it("reads nothing before the project answers", () => {
    expect(getProjectCrewRowViews(null)).toEqual([]);
  });
});

describe("project header", () => {
  it("names the bound repository, the gate default, and the checks", () => {
    const view = getProjectHeaderView(detail());
    expect(view?.isRepoBound).toBe(true);
    expect(view?.repoLabel).toBe("/repos/demo");
    expect(view?.policyLabel).toBe("Agent review");
    expect(view?.checkCommandsLabel).toBe("vp check");
  });

  it("says so when nothing is bound — the other two panels can never fill", () => {
    const view = getProjectHeaderView(detail({ repoBinding: null, checkCommands: [] }));
    expect(view?.isRepoBound).toBe(false);
    expect(view?.repoLabel).toBe("No repository bound");
    expect(view?.checkCommandsLabel).toBe("No check commands");
  });
});

describe("integration queue", () => {
  it("names every status and gives a bounce its reason and detail", () => {
    const rows = getCandidateRowViews(
      [
        candidate({
          id: "cand_bounced",
          status: "bounced",
          bounceCount: 2,
          bounce: {
            reason: "checks-failed",
            detail: "vp check exited 1",
            at: "2026-08-24T00:01:00.000Z",
          },
        } as Partial<IntegrationCandidate>),
      ],
      null,
    );

    expect(rows[0]?.statusLabel).toBe("Bounced");
    expect(rows[0]?.statusTone).toBe("error");
    expect(rows[0]?.bounceLabel).toBe("Checks failed");
    expect(rows[0]?.bounceDetail).toBe("vp check exited 1");
    expect(rows[0]?.bounceCountLabel).toBe("Bounced 2 times");
  });

  it("shows a recorded verdict even though the row went back to running", () => {
    const rows = getCandidateRowViews(
      [
        candidate({
          status: "running",
          gate: "human-approval",
          verdict: "approved",
          verdictDetail: "  ship it  ",
        } as Partial<IntegrationCandidate>),
      ],
      null,
    );

    expect(rows[0]?.statusLabel).toBe("Running");
    expect(rows[0]?.gateLabel).toBe("Human approval");
    expect(rows[0]?.verdictLabel).toBe("Approved");
    expect(rows[0]?.verdictDetail).toBe("ship it");
  });

  it("marks the running candidate as the head, not merely the oldest row", () => {
    const candidates = [
      candidate({ id: "a", status: "bounced" } as Partial<IntegrationCandidate>),
      candidate({ id: "b", status: "queued" } as Partial<IntegrationCandidate>),
      candidate({ id: "c", status: "running" } as Partial<IntegrationCandidate>),
    ];
    expect(queueHeadId(candidates)).toBe("c");
  });

  it("falls back to the oldest unsettled row when no pass is live", () => {
    const candidates = [
      candidate({ id: "a", status: "integrated" } as Partial<IntegrationCandidate>),
      candidate({ id: "b", status: "awaiting-approval" } as Partial<IntegrationCandidate>),
      candidate({ id: "c", status: "queued" } as Partial<IntegrationCandidate>),
    ];
    expect(queueHeadId(candidates)).toBe("b");
    // A fully settled queue has no head at all.
    expect(
      queueHeadId([candidate({ id: "a", status: "integrated" } as Partial<IntegrationCandidate>)]),
    ).toBeNull();
  });

  it("keeps the head marked on the whole queue while a status filter is on", () => {
    const candidates = [
      candidate({ id: "a", status: "running" } as Partial<IntegrationCandidate>),
      candidate({ id: "b", status: "queued" } as Partial<IntegrationCandidate>),
    ];
    const filtered = getCandidateRowViews(candidates, "queued");
    expect(filtered.map((row) => row.candidateId)).toEqual(["b"]);
    // 'b' is not the head just because it is the only row on screen.
    expect(filtered[0]?.isQueueHead).toBe(false);
  });

  it("counts every status, including the ones holding nothing", () => {
    const counts = candidateStatusCounts([
      candidate({ id: "a", status: "queued" } as Partial<IntegrationCandidate>),
      candidate({ id: "b", status: "queued" } as Partial<IntegrationCandidate>),
      candidate({ id: "c", status: "bounced" } as Partial<IntegrationCandidate>),
    ]);
    expect(counts.queued).toBe(2);
    expect(counts.bounced).toBe(1);
    expect(counts.integrated).toBe(0);
    expect(counts["awaiting-review"]).toBe(0);
  });
});

describe("isProjectNotFound", () => {
  it("recognises the tagged reason so the route can stop polling a dead row", () => {
    expect(isProjectNotFound({ _tag: "AdeCaptainError", reason: "project_not_found" })).toBe(true);
  });

  it("treats every other failure as transient — a dropped socket is not a deletion", () => {
    expect(isProjectNotFound({ _tag: "AdeCaptainError", reason: "persistence_failed" })).toBe(
      false,
    );
    expect(isProjectNotFound(new Error("socket closed"))).toBe(false);
    expect(isProjectNotFound(null)).toBe(false);
    expect(isProjectNotFound(undefined)).toBe(false);
  });
});

describe("unreadableRowsLabel", () => {
  it("stays silent when every row decoded", () => {
    expect(unreadableRowsLabel(0)).toBeNull();
    expect(unreadableRowsLabel(-1)).toBeNull();
  });

  it("counts skipped rows in words the panel can print", () => {
    expect(unreadableRowsLabel(1)).toBe("1 row could not be read and is not shown");
    expect(unreadableRowsLabel(3)).toBe("3 rows could not be read and are not shown");
  });
});

describe("publication stack", () => {
  it("is null before the project has ever published", () => {
    expect(getPublicationStackView(null)).toBeNull();
    expect(getPublicationStackView(undefined)).toBeNull();
  });

  it("labels the stack and orders layers with their PR state", () => {
    const view = getPublicationStackView({
      stack: {
        id: "stack_1",
        projectId: "project_1",
        mode: "chained",
        status: "building",
        stackUrl: "https://example.test/stack",
        nativeStackNumber: null,
        nativeStackNodeId: null,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
      layers: [layer(), layer({ id: "layer_2", order: 1, prNumber: null, prState: null })],
    } as unknown as AdePublicationStackView);

    expect(view?.statusLabel).toBe("Building");
    expect(view?.statusTone).toBe("info");
    expect(view?.modeLabel).toBe("Chained");
    expect(view?.layers[0]?.orderLabel).toBe("#1");
    expect(view?.layers[0]?.prLabel).toBe("PR #41");
    expect(view?.layers[0]?.prState).toBe("Open");
    // A layer with no PR yet is pending, not broken.
    expect(view?.layers[1]?.prLabel).toBe("No PR yet");
    expect(view?.layers[1]?.prState).toBeNull();
    expect(view?.layers[1]?.prTone).toBe("outline");
  });

  it("prefers the recorded SHA over the change id once a layer merges", () => {
    const view = getPublicationStackView({
      stack: {
        id: "stack_1",
        projectId: "project_1",
        mode: "native-stack",
        status: "merged",
        stackUrl: null,
        nativeStackNumber: 7,
        nativeStackNodeId: "node",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
      layers: [
        layer({ status: "merged", prState: "merged", mergeSha: "0123456789abcdef" }),
        layer({ id: "layer_2", order: 1, submittedSha: "fedcba9876543210", mergeSha: null }),
      ],
    } as unknown as AdePublicationStackView);

    expect(view?.modeLabel).toBe("Native stack");
    expect(view?.nativeStackLabel).toBe("Stack #7");
    expect(view?.layers[0]?.shaLabel).toBe("merged 0123456");
    expect(view?.layers[1]?.shaLabel).toBe("submitted fedcba9");
  });
});
