import type { AdeNeedsYouEntry, NeedsYouItemId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNeedsYouListItems,
  countActionableEntries,
  needsYouEmptyCopy,
  needsYouHistoryToggleLabel,
} from "./needsYou.logic";

const entry = (input: {
  readonly id: string;
  readonly status?: AdeNeedsYouEntry["item"]["status"];
  readonly actionable?: boolean;
}): AdeNeedsYouEntry =>
  ({
    item: {
      id: input.id as NeedsYouItemId,
      kind: "approval",
      subjectRefs: [],
      status: input.status ?? "open",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      resolvedAt: null,
    },
    title: `Item ${input.id}`,
    detail: "Detail.",
    actionable: input.actionable ?? false,
    action: (input.actionable ?? false) ? "approve-deny" : null,
    botId: null,
    projectId: null,
    assignmentId: null,
    integrationCandidateId: null,
    kernelEngine: null,
  }) as unknown as AdeNeedsYouEntry;

describe("buildNeedsYouListItems", () => {
  it("puts the items the captain can act on above the ones they can only watch", () => {
    const items = buildNeedsYouListItems([
      entry({ id: "watch" }),
      entry({ id: "act", actionable: true }),
    ]);
    expect(items.map((item) => item.key)).toEqual([
      "section:waiting",
      "item:act",
      "section:watching",
      "item:watch",
    ]);
  });

  it("files resolved items last regardless of whether they were actionable", () => {
    const items = buildNeedsYouListItems([
      entry({ id: "done", status: "resolved", actionable: true }),
      entry({ id: "act", actionable: true }),
    ]);
    expect(items.map((item) => item.key)).toEqual([
      "section:waiting",
      "item:act",
      "section:resolved",
      "item:done",
    ]);
  });

  it("emits no header for a bucket with nothing in it", () => {
    const items = buildNeedsYouListItems([entry({ id: "act", actionable: true })]);
    expect(items.filter((item) => item.kind === "section")).toHaveLength(1);
  });

  it("keeps the server's order inside a bucket", () => {
    const items = buildNeedsYouListItems([
      entry({ id: "first", actionable: true }),
      entry({ id: "second", actionable: true }),
    ]);
    expect(items.map((item) => item.key)).toEqual(["section:waiting", "item:first", "item:second"]);
  });

  it("renders nothing at all for an empty inbox", () => {
    expect(buildNeedsYouListItems([])).toEqual([]);
  });
});

describe("countActionableEntries", () => {
  it("counts only items that are open and still take a decision", () => {
    expect(
      countActionableEntries([
        entry({ id: "a", actionable: true }),
        entry({ id: "b" }),
        entry({ id: "c", status: "resolved", actionable: true }),
      ]),
    ).toBe(1);
  });
});

describe("needsYouEmptyCopy", () => {
  it("reads as good news when only open items were asked for", () => {
    expect(needsYouEmptyCopy(false).title).toBe("Nothing needs you");
  });

  it("does not report missing history as the point when history is on", () => {
    const copy = needsYouEmptyCopy(true);
    expect(copy.title).toBe("Nothing here yet");
    expect(copy.detail).toContain("resolved recently");
  });
});

describe("needsYouHistoryToggleLabel", () => {
  it("names what pressing it will do", () => {
    expect(needsYouHistoryToggleLabel(false)).toBe("Show resolved");
    expect(needsYouHistoryToggleLabel(true)).toBe("Hide resolved");
  });
});
