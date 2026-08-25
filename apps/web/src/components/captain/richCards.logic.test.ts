import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../chat/MessagesTimeline.logic";
import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import {
  parseAssignmentArtifactLine,
  parseAssignmentDeliveryText,
} from "../fleet/assignmentResult.logic";
import { buildBubbleTimelineItems } from "./bubbleTimeline.logic";
import {
  canSubmitSecureInput,
  hasPublicationArtifacts,
  isSecureInputEntry,
  resolveDeliveryStatus,
  resolveInstructionCardView,
  resolvePrResultArtifacts,
  resolveSecureInputFieldLabel,
} from "./richCards.logic";

/**
 * M5's design-mandated pure tests (MESSENGER-PIVOT §6): **card selection from
 * rows**. Everything a captain sees as a card is chosen here, from the same
 * `MessagesTimelineRow` union the IDE renders, so which card appears is pinned
 * by assertions rather than read off a screenshot.
 *
 * Fixtures are built the way M4's are — through the *real*
 * `deriveMessagesTimelineRows`, and through the *real* delivery text the
 * assignment engine renders — so these break if the row model or the engine's
 * wire format moves under the messenger.
 */

const OPEN = "<<<untrusted-content>>>";
const CLOSE = "<<</untrusted-content>>>";

/** Mirrors `renderAssignmentDeliveryText` in `AdeAssignmentEngine.ts`. */
function renderDelivery(
  items: ReadonlyArray<{
    readonly assignmentId: string;
    readonly recipientBotId: string;
    readonly instruction: string;
    readonly summary: string;
    readonly status?: "completed" | "failed" | "cancelled";
    readonly artifacts?: ReadonlyArray<string>;
  }>,
): string {
  const header =
    items.length === 1
      ? "An assignment you delegated has finished."
      : `${items.length} assignments you delegated have finished.`;
  const fence = (content: string) => `${OPEN}\n${content}\n${CLOSE}`;
  const blocks = items.map((item) => {
    const artifacts =
      item.artifacts === undefined || item.artifacts.length === 0
        ? ""
        : `\nArtifacts:\n${item.artifacts.map((line) => `- ${line}`).join("\n")}`;
    return (
      `### Assignment ${item.assignmentId} — ${item.status ?? "completed"} (bot ${item.recipientBotId})\n` +
      `Instruction:\n${fence(item.instruction)}\n` +
      `Summary:\n${fence(item.summary)}${artifacts}`
    );
  });
  return `${header}\n\n${blocks.join("\n\n")}`;
}

function messageEntry(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: string;
}) {
  return {
    id: `${input.id}-entry`,
    kind: "message" as const,
    createdAt: input.at,
    message: {
      id: input.id as never,
      role: input.role,
      text: input.text,
      turnId: null as never,
      createdAt: input.at,
      updatedAt: input.at,
      streaming: false,
    },
  };
}

function rowsFrom(
  timelineEntries: Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"],
): MessagesTimelineRow[] {
  return deriveMessagesTimelineRows({
    timelineEntries,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  });
}

function at(minute: number): string {
  return new Date(2026, 7, 24, 12, minute, 0).toISOString();
}

function deliveryOf(text: string) {
  const parsed = parseAssignmentDeliveryText(text);
  if (parsed === null) throw new Error("fixture is not a delivery");
  return parsed;
}

// ---------------------------------------------------------------------------

describe("parseAssignmentArtifactLine", () => {
  it("recovers each tag the engine flattens", () => {
    expect(parseAssignmentArtifactLine("jj change zzxqrt (project proj-1)")).toEqual({
      kind: "jjChange",
      changeId: "zzxqrt",
      projectId: "proj-1",
    });
    expect(parseAssignmentArtifactLine("publication layer layer-2 (stack stack-9)")).toEqual({
      kind: "publicationLayer",
      stackId: "stack-9",
      layerId: "layer-2",
    });
    expect(parseAssignmentArtifactLine("file apps/web/src/foo.ts")).toEqual({
      kind: "file",
      path: "apps/web/src/foo.ts",
    });
    expect(parseAssignmentArtifactLine("url https://example.com/pull/7")).toEqual({
      kind: "url",
      href: "https://example.com/pull/7",
    });
  });

  it("refuses prose that merely starts like an artifact", () => {
    // The danger is one direction only: a summary line promoted into a typed
    // artifact gets an Open action pointing nowhere.
    expect(parseAssignmentArtifactLine("published the layer")).toBeNull();
    expect(parseAssignmentArtifactLine("jj change with no project")).toBeNull();
    expect(parseAssignmentArtifactLine("publication layer alone")).toBeNull();
    expect(parseAssignmentArtifactLine("")).toBeNull();
  });
});

describe("hasPublicationArtifacts", () => {
  it("is true for a publication layer and for a bare URL", () => {
    const layer = deliveryOf(
      renderDelivery([
        {
          assignmentId: "a-1",
          recipientBotId: "bot-1",
          instruction: "ship it",
          summary: "done",
          artifacts: ["publication layer layer-1 (stack stack-1)"],
        },
      ]),
    );
    expect(hasPublicationArtifacts(layer)).toBe(true);

    const url = deliveryOf(
      renderDelivery([
        {
          assignmentId: "a-2",
          recipientBotId: "bot-1",
          instruction: "ship it",
          summary: "done",
          artifacts: ["url https://example.com/pull/7"],
        },
      ]),
    );
    expect(hasPublicationArtifacts(url)).toBe(true);
  });

  it("is false for work that only touched files or a change", () => {
    // Promoting these would offer a "View PR" for a PR that does not exist.
    const work = deliveryOf(
      renderDelivery([
        {
          assignmentId: "a-3",
          recipientBotId: "bot-1",
          instruction: "look into it",
          summary: "looked",
          artifacts: ["file apps/web/src/foo.ts", "jj change zzxqrt (project proj-1)"],
        },
      ]),
    );
    expect(hasPublicationArtifacts(work)).toBe(false);

    const none = deliveryOf(
      renderDelivery([
        { assignmentId: "a-4", recipientBotId: "bot-1", instruction: "think", summary: "thought" },
      ]),
    );
    expect(hasPublicationArtifacts(none)).toBe(false);
  });

  it("splits artifacts into typed buckets in first-seen order", () => {
    const delivery = deliveryOf(
      renderDelivery([
        {
          assignmentId: "a-5",
          recipientBotId: "bot-1",
          instruction: "ship",
          summary: "shipped",
          artifacts: [
            "publication layer layer-a (stack stack-1)",
            "publication layer layer-b (stack stack-1)",
            "url https://example.com/pull/7",
            "file README.md",
            "not an artifact at all",
          ],
        },
      ]),
    );
    const artifacts = resolvePrResultArtifacts(delivery);
    expect(artifacts.layers.map((layer) => layer.layerId)).toEqual(["layer-a", "layer-b"]);
    expect(artifacts.urls.map((url) => url.href)).toEqual(["https://example.com/pull/7"]);
    expect(artifacts.files.map((file) => file.path)).toEqual(["README.md"]);
    // The unparsed line is dropped here and still shown verbatim by
    // `AssignmentResultCard`; nothing is lost, it just is not typed.
    expect(artifacts.jjChanges).toEqual([]);
  });
});

describe("resolveDeliveryStatus", () => {
  it("reports the worst outcome in a batch, not the common one", () => {
    const mixed = deliveryOf(
      renderDelivery([
        { assignmentId: "a-1", recipientBotId: "b", instruction: "i", summary: "s" },
        {
          assignmentId: "a-2",
          recipientBotId: "b",
          instruction: "i",
          summary: "s",
          status: "failed",
        },
      ]),
    );
    expect(resolveDeliveryStatus(mixed)).toBe("failed");

    const cancelled = deliveryOf(
      renderDelivery([
        { assignmentId: "a-1", recipientBotId: "b", instruction: "i", summary: "s" },
        {
          assignmentId: "a-2",
          recipientBotId: "b",
          instruction: "i",
          summary: "s",
          status: "cancelled",
        },
      ]),
    );
    expect(resolveDeliveryStatus(cancelled)).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Card selection from rows — the design-mandated test.
// ---------------------------------------------------------------------------

describe("card selection from rows", () => {
  it("selects the PR card for a publishing delivery and the result card otherwise", () => {
    const rows = rowsFrom([
      messageEntry({
        id: "m-1",
        role: "user",
        at: at(1),
        text: renderDelivery([
          {
            assignmentId: "a-1",
            recipientBotId: "bot-1",
            instruction: "ship",
            summary: "shipped",
            artifacts: ["publication layer layer-1 (stack stack-1)"],
          },
        ]),
      }),
      messageEntry({ id: "m-2", role: "assistant", at: at(2), text: "Landed." }),
      messageEntry({
        id: "m-3",
        role: "user",
        at: at(3),
        text: renderDelivery([
          {
            assignmentId: "a-2",
            recipientBotId: "bot-1",
            instruction: "look",
            summary: "looked",
            artifacts: ["file README.md"],
          },
        ]),
      }),
    ]);
    const kinds = buildBubbleTimelineItems({ rows })
      .filter((item) => item.kind !== "day-divider")
      .map((item) => item.kind);
    expect(kinds).toEqual(["pr-result", "bubble", "assignment-result"]);
  });

  it("keeps a multi-assignment run folded into one attribution line", () => {
    // The PR card is a *single*-delivery decision. A run of them is still
    // noise, and M4's fold owns it — promoting each one would undo that.
    const delivery = (id: string) =>
      renderDelivery([
        {
          assignmentId: id,
          recipientBotId: "bot-1",
          instruction: "ship",
          summary: "shipped",
          artifacts: ["publication layer layer-1 (stack stack-1)"],
        },
      ]);
    const rows = rowsFrom([
      messageEntry({ id: "m-1", role: "user", at: at(1), text: delivery("a-1") }),
      messageEntry({ id: "m-2", role: "user", at: at(2), text: delivery("a-2") }),
    ]);
    const kinds = buildBubbleTimelineItems({ rows })
      .filter((item) => item.kind !== "day-divider")
      .map((item) => item.kind);
    expect(kinds).toEqual(["attribution"]);
  });

  it("selects the instruction card for a bot's task list, inside its run", () => {
    const rows = rowsFrom([
      messageEntry({ id: "m-1", role: "assistant", at: at(1), text: "On it." }),
      messageEntry({
        id: "m-2",
        role: "assistant",
        at: at(2),
        text: "Plan:\n\n- [x] Read `foo.ts`\n- [ ] Write the test\n",
      }),
      messageEntry({ id: "m-3", role: "assistant", at: at(3), text: "Starting now." }),
    ]);
    const items = buildBubbleTimelineItems({ rows }).filter((item) => item.kind !== "day-divider");
    expect(items.map((item) => item.kind)).toEqual(["bubble", "instruction", "bubble"]);
    // The neighbours keep the run's geometry — the card does not split the run.
    expect(items[0]).toMatchObject({ kind: "bubble", groupPosition: "first" });
    expect(items[2]).toMatchObject({ kind: "bubble", groupPosition: "last" });
  });

  it("never promotes a captain's own checklist", () => {
    const rows = rowsFrom([
      messageEntry({
        id: "m-1",
        role: "user",
        at: at(1),
        text: "Do these:\n\n- [ ] one\n- [ ] two\n",
      }),
    ]);
    const kinds = buildBubbleTimelineItems({ rows })
      .filter((item) => item.kind !== "day-divider")
      .map((item) => item.kind);
    expect(kinds).toEqual(["bubble"]);
  });
});

// ---------------------------------------------------------------------------

describe("resolveInstructionCardView", () => {
  it("reads a task list with its title, lead, and trailing prose", () => {
    const view = resolveInstructionCardView(
      "Here is what I found.\n\nPlan:\n\n- [x] Read the file\n- [ ] Fix `resolveThing`\n- [ ] Add a test\n\nI will start at the top.",
    );
    expect(view).not.toBeNull();
    expect(view?.title).toBe("Plan:");
    expect(view?.leadMarkdown).toBe("Here is what I found.");
    expect(view?.trailingMarkdown).toBe("I will start at the top.");
    expect(view?.completedCount).toBe(1);
    expect(view?.items.map((item) => item.markdown)).toEqual([
      "Read the file",
      "Fix `resolveThing`",
      "Add a test",
    ]);
  });

  it("takes a heading as the title and records nesting", () => {
    const view = resolveInstructionCardView("## Steps\n\n- [ ] Top\n  - [ ] Nested\n- [X] Done\n");
    expect(view?.title).toBe("Steps");
    expect(view?.items.map((item) => item.depth)).toEqual([0, 1, 0]);
    expect(view?.items.map((item) => item.checked)).toEqual([false, false, true]);
  });

  it("folds a wrapped continuation line into the item above it", () => {
    const view = resolveInstructionCardView(
      "- [ ] Update the parser\n      so it handles fences\n- [ ] Ship\n",
    );
    expect(view?.items[0]?.markdown).toBe("Update the parser\nso it handles fences");
    expect(view?.items).toHaveLength(2);
  });

  it("refuses a single checkbox, and prose that has none", () => {
    // One checkbox in a paragraph is a sentence with a box in it.
    expect(resolveInstructionCardView("- [ ] just the one\n")).toBeNull();
    expect(resolveInstructionCardView("I will read the file and then fix it.")).toBeNull();
  });

  it("refuses a checklist inside a fenced code block", () => {
    // Sample text the bot is *showing*, not a plan it is *keeping*.
    expect(
      resolveInstructionCardView("Write this in the issue:\n\n```md\n- [ ] one\n- [ ] two\n```\n"),
    ).toBeNull();
  });

  it("ends the list at the first blank-separated paragraph", () => {
    const view = resolveInstructionCardView(
      "- [ ] one\n- [ ] two\n\nThen I will open a PR.\n\n- [ ] three\n",
    );
    expect(view?.items).toHaveLength(2);
    expect(view?.trailingMarkdown).toBe("Then I will open a PR.\n\n- [ ] three");
  });
});

// ---------------------------------------------------------------------------

describe("secure input selection", () => {
  it("is the `form` kind and nothing else", () => {
    // Deliberately not a title/detail heuristic: the server already withholds
    // roster previews for `form` alone, and a second, weaker rule beside that
    // one could disagree with it.
    expect(isSecureInputEntry({ item: { kind: "form" } })).toBe(true);
    for (const kind of ["approval", "kernel-down", "stall", "provision-failure"]) {
      expect(isSecureInputEntry({ item: { kind } })).toBe(false);
    }
  });

  it("turns the server's one-line title into a field label", () => {
    expect(resolveSecureInputFieldLabel("Deploy Bot needs a token:")).toBe(
      "Deploy Bot needs a token",
    );
    expect(resolveSecureInputFieldLabel("   ")).toBe("Secret value");
  });

  it("refuses to submit nothing, a busy card, or a retired item", () => {
    // An empty secret retires the item without answering it, and the item is
    // the only record that anything was ever asked.
    expect(canSubmitSecureInput({ value: "sk-x", busy: false, status: "open" })).toBe(true);
    expect(canSubmitSecureInput({ value: "", busy: false, status: "open" })).toBe(false);
    expect(canSubmitSecureInput({ value: "sk-x", busy: true, status: "open" })).toBe(false);
    expect(canSubmitSecureInput({ value: "sk-x", busy: false, status: "resolved" })).toBe(false);
  });
});
