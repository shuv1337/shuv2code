import { describe, expect, it } from "vite-plus/test";

import type { AdeNeedsYouEntry, NeedsYouItemId } from "@shuv2code/contracts";

import {
  canApproveWithSession,
  describeDecisionOutcome,
  entriesForSubject,
  getNeedsYouDecisionView,
  selectNeedsYouEntry,
} from "./NeedsYouInbox.logic";

const entry = (overrides: {
  readonly id: string;
  readonly kind?: AdeNeedsYouEntry["item"]["kind"];
  readonly status?: AdeNeedsYouEntry["item"]["status"];
  readonly actionable?: boolean;
  readonly action?: AdeNeedsYouEntry["action"];
  readonly botId?: string | null;
  readonly projectId?: string | null;
}): AdeNeedsYouEntry =>
  ({
    item: {
      id: overrides.id as NeedsYouItemId,
      kind: overrides.kind ?? "approval",
      subjectRefs: [],
      status: overrides.status ?? "open",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      resolvedAt: null,
    },
    title: `Item ${overrides.id}`,
    detail: "detail",
    actionable: overrides.actionable ?? (overrides.status ?? "open") === "open",
    action:
      overrides.action ??
      ((overrides.actionable ?? (overrides.status ?? "open") === "open") ? "approve-deny" : null),
    botId: overrides.botId ?? null,
    projectId: overrides.projectId ?? null,
    assignmentId: null,
    integrationCandidateId: "candidate-1",
    kernelEngine: null,
  }) as unknown as AdeNeedsYouEntry;

describe("entriesForSubject", () => {
  it("shows only open items about the thing on screen", () => {
    const entries = [
      entry({ id: "mine", botId: "bot-1" }),
      entry({ id: "theirs", botId: "bot-2" }),
      entry({ id: "done", botId: "bot-1", status: "resolved", actionable: false }),
    ];
    expect(entriesForSubject(entries, { botId: "bot-1" }).map((each) => each.item.id)).toEqual([
      "mine",
    ]);
  });

  it("renders nothing when the surface names no subject", () => {
    expect(entriesForSubject([entry({ id: "a", botId: "bot-1" })], {})).toEqual([]);
    expect(entriesForSubject([entry({ id: "a", botId: "bot-1" })], { botId: null })).toEqual([]);
  });

  it("matches on any named subject, so a project panel sees its project's items", () => {
    const entries = [
      entry({ id: "by-project", projectId: "project-1" }),
      entry({ id: "by-bot", botId: "bot-1" }),
      entry({ id: "neither" }),
    ];
    expect(
      entriesForSubject(entries, { botId: "bot-1", projectId: "project-1" }).map(
        (each) => each.item.id,
      ),
    ).toEqual(["by-project", "by-bot"]);
  });
});

describe("selectNeedsYouEntry", () => {
  it("honours an explicit selection", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    expect(selectNeedsYouEntry(entries, "b" as NeedsYouItemId)?.item.id).toBe("b");
  });

  it("opens on the first decision when nothing is selected, or the selection is gone", () => {
    const entries = [
      entry({ id: "info", kind: "stall", actionable: false, action: null }),
      entry({ id: "decision" }),
    ];
    expect(selectNeedsYouEntry(entries, null)?.item.id).toBe("decision");
    expect(selectNeedsYouEntry(entries, "vanished" as NeedsYouItemId)?.item.id).toBe("decision");
  });

  it("falls back to the first row, then to nothing", () => {
    const entries = [entry({ id: "info", kind: "stall", actionable: false, action: null })];
    expect(selectNeedsYouEntry(entries, null)?.item.id).toBe("info");
    expect(selectNeedsYouEntry([], null)).toBeNull();
  });
});

describe("canApproveWithSession", () => {
  it("requires the ade:approve scope when the session reports scopes", () => {
    expect(canApproveWithSession({ authenticated: true, scopes: ["orchestration:operate"] })).toBe(
      false,
    );
    expect(
      canApproveWithSession({
        authenticated: true,
        scopes: ["orchestration:operate", "ade:approve"],
      }),
    ).toBe(true);
  });

  it("stays optimistic while the answer is unknown; the server is the authority", () => {
    expect(canApproveWithSession(null)).toBe(true);
    expect(canApproveWithSession({ authenticated: true })).toBe(true);
  });
});

describe("getNeedsYouDecisionView", () => {
  it("offers the decision on an actionable item held by an approving client", () => {
    expect(
      getNeedsYouDecisionView({ entry: entry({ id: "a" }), canApprove: true, busy: false }),
    ).toEqual({ canDecide: true, action: "approve-deny", unavailableReason: null });
  });

  it("offers a single Acknowledge on an item nothing is waiting on", () => {
    // An unroutable repair has no verdict to give; the captain is clearing a
    // notice, and Approve/Deny would invent a decision with no recipient.
    expect(
      getNeedsYouDecisionView({
        entry: entry({ id: "a", kind: "stall", action: "acknowledge" }),
        canApprove: true,
        busy: false,
      }),
    ).toEqual({ canDecide: true, action: "acknowledge", unavailableReason: null });
  });

  it("explains an unscoped client rather than showing buttons that will fail", () => {
    const view = getNeedsYouDecisionView({
      entry: entry({ id: "a" }),
      canApprove: false,
      busy: false,
    });
    expect(view.canDecide).toBe(false);
    expect(view.unavailableReason).toContain("ade:approve");
  });

  it("says nothing to decide on kinds that clear themselves, and on resolved items", () => {
    expect(
      getNeedsYouDecisionView({
        entry: entry({ id: "a", kind: "kernel-down", actionable: false, action: null }),
        canApprove: true,
        busy: false,
      }).unavailableReason,
    ).toContain("clears on its own");
    expect(
      getNeedsYouDecisionView({
        entry: entry({ id: "a", status: "resolved", actionable: false, action: null }),
        canApprove: true,
        busy: false,
      }).unavailableReason,
    ).toBe("Already resolved.");
  });
});

describe("describeDecisionOutcome", () => {
  it("reports the verdict that landed", () => {
    expect(
      describeDecisionOutcome({
        reason: null,
        decision: "approve",
        failed: false,
        fallback: "x",
      }),
    ).toEqual({ tone: "ok", message: "Approved." });
    expect(
      describeDecisionOutcome({ reason: null, decision: "deny", failed: false, fallback: "x" })
        .message,
    ).toContain("Denied");
    expect(
      describeDecisionOutcome({
        reason: null,
        decision: "acknowledge",
        failed: false,
        fallback: "x",
      }),
    ).toEqual({ tone: "ok", message: "Cleared." });
  });

  it("treats a second resolution as an outcome, not a failure", () => {
    // The whole point of one durable item: whoever got there first, the
    // captain is told it is handled — not that something broke.
    for (const reason of ["needs_you_already_resolved", "needs_you_not_found"] as const) {
      expect(
        describeDecisionOutcome({ reason, decision: "approve", failed: true, fallback: "x" }),
      ).toEqual({ tone: "conflict", message: "Already handled elsewhere." });
    }
  });

  it("surfaces a real failure as one", () => {
    expect(
      describeDecisionOutcome({
        reason: "needs_you_decision_rejected",
        decision: "approve",
        failed: true,
        fallback: "The candidate moved on.",
      }),
    ).toEqual({ tone: "error", message: "The candidate moved on." });
  });
});
