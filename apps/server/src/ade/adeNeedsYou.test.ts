import { describe, expect, it } from "@effect/vitest";

import type { AdeNeedsYouEntry } from "@shuv2code/contracts";

import {
  compareNeedsYouEntries,
  emptyNeedsYouNaming,
  flattenSubjectRefs,
  isActionableKind,
  projectNeedsYouRow,
  type NeedsYouRow,
} from "./adeNeedsYou.ts";

const row = (overrides: Partial<NeedsYouRow> = {}): NeedsYouRow => ({
  needs_you_item_id: "item-1",
  kind: "approval",
  subject_refs_json: "[]",
  status: "open",
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:00:00.000Z",
  resolved_at: null,
  ...overrides,
});

const naming = {
  botNames: new Map([["bot-1", "Coder"]]),
  projectNames: new Map([["project-1", "Demo"]]),
  assignmentInstructions: new Map([["assignment-1", "Rewrite the parser"]]),
};

describe("flattenSubjectRefs", () => {
  it("pulls every subject id out of the durable blob", () => {
    const flat = flattenSubjectRefs(
      JSON.stringify([
        { _tag: "integrationCandidate", integrationCandidateId: "candidate-1" },
        { _tag: "project", projectId: "project-1" },
        { _tag: "bot", botId: "bot-1" },
        { _tag: "assignment", assignmentId: "assignment-1" },
        { _tag: "kernel", engine: "shuvcode" },
      ]),
    );
    expect(flat).toEqual({
      botId: "bot-1",
      projectId: "project-1",
      assignmentId: "assignment-1",
      integrationCandidateId: "candidate-1",
      kernelEngine: "shuvcode",
    });
  });

  it("keeps an unparseable item visible rather than hiding what the badge counts", () => {
    expect(flattenSubjectRefs("not json").botId).toBeNull();
    expect(flattenSubjectRefs('{"_tag":"bot"}').botId).toBeNull();
    expect(flattenSubjectRefs('[{"_tag":"unknown"},null,7]').botId).toBeNull();
  });
});

describe("projectNeedsYouRow", () => {
  it("names the project and the author on an approval, and offers the decision", () => {
    const entry = projectNeedsYouRow(
      row({
        subject_refs_json: JSON.stringify([
          { _tag: "integrationCandidate", integrationCandidateId: "candidate-1" },
          { _tag: "project", projectId: "project-1" },
          { _tag: "bot", botId: "bot-1" },
        ]),
      }),
      naming,
    );
    expect(entry.title).toContain("Demo");
    expect(entry.detail).toContain("Coder");
    expect(entry.actionable).toBe(true);
    expect(entry.integrationCandidateId).toBe("candidate-1");
  });

  it("never offers a decision on a resolved item, whoever resolved it", () => {
    const entry = projectNeedsYouRow(
      row({ status: "resolved", resolved_at: "2026-08-24T01:00:00.000Z" }),
      emptyNeedsYouNaming,
    );
    expect(entry.actionable).toBe(false);
    expect(entry.item.resolvedAt).toBe("2026-08-24T01:00:00.000Z");
  });

  it("describes the kinds that resolve themselves without offering a decision", () => {
    for (const kind of ["kernel-down", "stall", "provision-failure", "form"] as const) {
      const entry = projectNeedsYouRow(row({ kind }), naming);
      expect(isActionableKind(kind)).toBe(false);
      expect(entry.actionable).toBe(false);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });

  it("quotes the stalled assignment so the captain knows what is stuck", () => {
    const entry = projectNeedsYouRow(
      row({
        kind: "stall",
        subject_refs_json: JSON.stringify([
          { _tag: "assignment", assignmentId: "assignment-1" },
          { _tag: "bot", botId: "bot-1" },
        ]),
      }),
      naming,
    );
    expect(entry.title).toContain("Coder");
    expect(entry.detail).toContain("Rewrite the parser");
    expect(entry.assignmentId).toBe("assignment-1");
  });
});

describe("compareNeedsYouEntries", () => {
  it("puts what the captain can act on first, then open work, then history", () => {
    const entry = (
      id: string,
      actionable: boolean,
      status: "open" | "resolved",
      createdAt: string,
    ): AdeNeedsYouEntry =>
      ({
        ...projectNeedsYouRow(
          row({
            needs_you_item_id: id,
            status,
            created_at: createdAt,
            kind: actionable ? "approval" : "stall",
          }),
          emptyNeedsYouNaming,
        ),
      }) as AdeNeedsYouEntry;

    const sorted = [
      entry("old-open", false, "open", "2026-08-01T00:00:00.000Z"),
      entry("resolved", false, "resolved", "2026-08-30T00:00:00.000Z"),
      entry("approval", true, "open", "2026-08-02T00:00:00.000Z"),
      entry("new-open", false, "open", "2026-08-20T00:00:00.000Z"),
    ].toSorted(compareNeedsYouEntries);

    expect(sorted.map((each) => each.item.id)).toEqual([
      "approval",
      "new-open",
      "old-open",
      "resolved",
    ]);
  });
});
