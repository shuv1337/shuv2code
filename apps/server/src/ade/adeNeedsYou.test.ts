import { describe, expect, it } from "@effect/vitest";

import type { AdeNeedsYouEntry } from "@shuv2code/contracts";

import {
  compareNeedsYouEntries,
  emptyNeedsYouNaming,
  flattenSubjectRefs,
  needsYouActionFor,
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
    expect(entry.action).toBe("approve-deny");
    expect(entry.integrationCandidateId).toBe("candidate-1");
  });

  it("never offers a decision on a resolved item, whoever resolved it", () => {
    const entry = projectNeedsYouRow(
      row({ status: "resolved", resolved_at: "2026-08-24T01:00:00.000Z" }),
      emptyNeedsYouNaming,
    );
    expect(entry.actionable).toBe(false);
    expect(entry.action).toBeNull();
    expect(entry.item.resolvedAt).toBe("2026-08-24T01:00:00.000Z");
  });

  it("describes the kinds that resolve themselves without offering a decision", () => {
    for (const kind of ["kernel-down", "stall", "provision-failure"] as const) {
      const entry = projectNeedsYouRow(row({ kind }), naming);
      expect(entry.actionable).toBe(false);
      expect(entry.action).toBeNull();
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });

  /**
   * A `form` item asks the captain to *type a value* (MESSENGER-PIVOT §6 M5).
   * No service can satisfy that, so without an action it would count on the
   * badge forever — the same trap the unroutable repair describes.
   * `acknowledge` rather than `approve-deny` because there is no verdict to
   * forward and nobody to forward it to; the captain's answer retires the item
   * and travels no further.
   */
  it("offers a secure request an answer instead of leaving it to count forever", () => {
    const entry = projectNeedsYouRow(row({ kind: "form" }), naming);
    expect(entry.actionable).toBe(true);
    expect(entry.action).toBe("acknowledge");
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.detail.length).toBeGreaterThan(0);
  });

  /**
   * The unroutable-repair item (integration service, ADR §7.2/§13.3) is a
   * `stall` naming only a candidate. Rendered as an ordinary stall it tells the
   * captain to steer a bot that does not exist — and nothing ever clears it,
   * because the engine's stall resolver keys on an assignment id it lacks.
   */
  it("renders a candidate-only stall as an unrepairable bounce, and lets it be acknowledged", () => {
    const entry = projectNeedsYouRow(
      row({
        kind: "stall",
        subject_refs_json: JSON.stringify([
          { _tag: "integrationCandidate", integrationCandidateId: "candidate-9" },
        ]),
      }),
      naming,
    );

    expect(entry.title).not.toContain("gone quiet");
    expect(entry.detail).not.toContain("Steer");
    expect(entry.detail).toContain("candidate-9");
    expect(entry.detail).toMatch(/archived|gone/);
    expect(entry.action).toBe("acknowledge");
    expect(entry.actionable).toBe(true);
    expect(entry.assignmentId).toBeNull();
  });

  it("still reads an assignment-shaped stall as a stall, so the engine keeps owning it", () => {
    const flat = {
      botId: "bot-1",
      projectId: null,
      assignmentId: "assignment-1",
      integrationCandidateId: "candidate-9",
      kernelEngine: null,
    };
    // A stall that names an assignment resolves itself when the assignment
    // exits; offering the captain an Acknowledge would race that.
    expect(needsYouActionFor({ kind: "stall", status: "open" }, flat)).toBeNull();
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
