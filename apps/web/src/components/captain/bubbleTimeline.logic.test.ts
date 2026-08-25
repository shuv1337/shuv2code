import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../chat/MessagesTimeline.logic";
import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import {
  buildBubbleTimelineItems,
  formatAttributionLabel,
  formatTraceDuration,
  resolveBubbleDayKey,
  resolveBubbleMessageDisplay,
  resolveBubbleTimelineActivity,
  resolveTraceCardSummary,
  resolveTurnFoldAnchorKey,
  shouldRestoreBubblePosition,
} from "./bubbleTimeline.logic";

/**
 * The heavy pure test file for M4 (MESSENGER-PIVOT §6): fold rules and
 * classification against fixture timelines built the same way
 * `MessagesTimeline.logic.test.ts` builds them — real
 * `deriveMessagesTimelineRows` output wherever a fixture can produce it, so
 * these assertions break if the row model moves under the messenger.
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
  }>,
): string {
  const header =
    items.length === 1
      ? "An assignment you delegated has finished."
      : `${items.length} assignments you delegated have finished.`;
  const fence = (content: string) => `${OPEN}\n${content}\n${CLOSE}`;
  const blocks = items.map(
    (item) =>
      `### Assignment ${item.assignmentId} — completed (bot ${item.recipientBotId})\n` +
      `Instruction:\n${fence(item.instruction)}\n` +
      `Summary:\n${fence(item.summary)}`,
  );
  return `${header}\n\n${blocks.join("\n\n")}`;
}

function messageEntry(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: string;
  readonly turnId?: string;
}) {
  return {
    id: `${input.id}-entry`,
    kind: "message" as const,
    createdAt: input.at,
    message: {
      id: input.id as never,
      role: input.role,
      text: input.text,
      turnId: (input.turnId ?? null) as never,
      createdAt: input.at,
      updatedAt: input.at,
      streaming: false,
    },
  };
}

function workEntry(input: { readonly id: string; readonly label: string; readonly at: string }) {
  return {
    id: `${input.id}-entry`,
    kind: "work" as const,
    createdAt: input.at,
    entry: {
      id: input.id,
      createdAt: input.at,
      turnId: "turn-1" as never,
      label: input.label,
      tone: "tool" as const,
    },
  };
}

function rowsFrom(
  timelineEntries: Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"],
): MessagesTimelineRow[] {
  return deriveMessagesTimelineRows({
    timelineEntries,
    expandedTurnIds: new Set(["turn-1" as never]),
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  });
}

/**
 * Deterministic local-noon timestamps. Day dividers are resolved in *local*
 * time on purpose, so fixtures sit far from midnight and the assertions hold in
 * any timezone the suite runs in.
 */
function localNoon(year: number, month: number, day: number, minute = 0): string {
  return new Date(year, month - 1, day, 12, minute, 0).toISOString();
}

describe("resolveBubbleDayKey", () => {
  it("keys by the local calendar day and rejects unparseable input", () => {
    const at = localNoon(2026, 3, 17);
    const expected = new Date(at);
    expect(resolveBubbleDayKey(at)).toBe(
      `${expected.getFullYear()}-${`${expected.getMonth() + 1}`.padStart(2, "0")}-${`${expected.getDate()}`.padStart(2, "0")}`,
    );
    expect(resolveBubbleDayKey("not a date")).toBeNull();
  });
});

describe("formatAttributionLabel", () => {
  it("names one bot, two bots, and folds the rest into a count", () => {
    expect(formatAttributionLabel(2, ["Code Monkey"])).toBe("2 messages with Code Monkey");
    expect(formatAttributionLabel(1, ["Code Monkey"])).toBe("1 message with Code Monkey");
    expect(formatAttributionLabel(3, ["Code Monkey", "Reviewer"])).toBe(
      "3 messages with Code Monkey and Reviewer",
    );
    expect(formatAttributionLabel(5, ["Code Monkey", "Reviewer", "Second Mate"])).toBe(
      "5 messages with Code Monkey and 2 others",
    );
  });

  it("degrades to a generic line rather than an empty one", () => {
    expect(formatAttributionLabel(2, [])).toBe("2 messages with a sub-agent");
  });
});

describe("buildBubbleTimelineItems — lanes", () => {
  it("puts captain and bot text in bubbles and everything else in traces", () => {
    const at = localNoon(2026, 3, 17);
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({ id: "user-1", role: "user", text: "Fix the retry", at }),
        workEntry({ id: "work-1", label: "Ran command", at: localNoon(2026, 3, 17, 1) }),
        messageEntry({
          id: "assistant-1",
          role: "assistant",
          text: "Done.",
          at: localNoon(2026, 3, 17, 2),
          turnId: "turn-1",
        }),
      ]),
    });

    // One divider (all three sit on the same local day), the two messages as
    // bubbles in order, and every work-derived row in the trace lane.
    expect(items.filter((item) => item.kind === "day-divider")).toHaveLength(1);
    expect(
      items.filter((item) => item.kind === "bubble").map((item) => item.row.message.id),
    ).toEqual(["user-1", "assistant-1"]);
    expect(items.some((item) => item.kind === "trace")).toBe(true);
    expect(items.every((item) => item.kind !== "trace" || item.row.kind !== "message")).toBe(true);
  });

  it("never drops a row: every input row reaches exactly one item", () => {
    const rows = rowsFrom([
      messageEntry({ id: "user-1", role: "user", text: "One", at: localNoon(2026, 3, 17) }),
      workEntry({ id: "work-1", label: "Ran command", at: localNoon(2026, 3, 17, 1) }),
      messageEntry({
        id: "assistant-1",
        role: "assistant",
        text: "Two",
        at: localNoon(2026, 3, 17, 2),
        turnId: "turn-1",
      }),
    ]);
    const items = buildBubbleTimelineItems({ rows });
    const covered = new Set<string>();
    for (const item of items) {
      if (item.kind === "day-divider") continue;
      if (item.kind === "attribution") {
        for (const row of item.rows) covered.add(row.id);
        continue;
      }
      covered.add(item.row.id);
    }
    expect(covered).toEqual(new Set(rows.map((row) => row.id)));
  });
});

describe("buildBubbleTimelineItems — bubble runs", () => {
  it("marks first/middle/last across a run and hangs the avatar off the last bot bubble", () => {
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({
          id: "assistant-1",
          role: "assistant",
          text: "One",
          at: localNoon(2026, 3, 17, 0),
          turnId: "turn-1",
        }),
        messageEntry({
          id: "assistant-2",
          role: "assistant",
          text: "Two",
          at: localNoon(2026, 3, 17, 1),
          turnId: "turn-1",
        }),
        messageEntry({
          id: "assistant-3",
          role: "assistant",
          text: "Three",
          at: localNoon(2026, 3, 17, 2),
          turnId: "turn-1",
        }),
      ]),
    });

    const bubbles = items.filter((item) => item.kind === "bubble");
    expect(bubbles.map((bubble) => bubble.groupPosition)).toEqual(["first", "middle", "last"]);
    expect(bubbles.map((bubble) => bubble.showAvatar)).toEqual([false, false, true]);
  });

  it("breaks a run when the author changes, and never shows an avatar on a captain bubble", () => {
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({ id: "user-1", role: "user", text: "A", at: localNoon(2026, 3, 17, 0) }),
        messageEntry({ id: "user-2", role: "user", text: "B", at: localNoon(2026, 3, 17, 1) }),
        messageEntry({
          id: "assistant-1",
          role: "assistant",
          text: "C",
          at: localNoon(2026, 3, 17, 2),
          turnId: "turn-1",
        }),
      ]),
    });

    const bubbles = items.filter((item) => item.kind === "bubble");
    expect(bubbles.map((bubble) => [bubble.author, bubble.groupPosition])).toEqual([
      ["captain", "first"],
      ["captain", "last"],
      ["bot", "single"],
    ]);
    expect(bubbles.filter((bubble) => bubble.author === "captain").some((b) => b.showAvatar)).toBe(
      false,
    );
  });

  it("breaks a run at a trace and at a day boundary", () => {
    const acrossTrace = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({ id: "user-1", role: "user", text: "A", at: localNoon(2026, 3, 17, 0) }),
        workEntry({ id: "work-1", label: "Ran command", at: localNoon(2026, 3, 17, 1) }),
        messageEntry({ id: "user-2", role: "user", text: "B", at: localNoon(2026, 3, 17, 2) }),
      ]),
    });
    expect(
      acrossTrace.filter((item) => item.kind === "bubble").map((item) => item.groupPosition),
    ).toEqual(["single", "single"]);

    const acrossDays = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({ id: "user-1", role: "user", text: "A", at: localNoon(2026, 3, 17) }),
        messageEntry({ id: "user-2", role: "user", text: "B", at: localNoon(2026, 3, 18) }),
      ]),
    });
    expect(acrossDays.map((item) => item.kind)).toEqual([
      "day-divider",
      "bubble",
      "day-divider",
      "bubble",
    ]);
  });
});

describe("buildBubbleTimelineItems — day dividers", () => {
  it("emits one divider per calendar day, in order, and none for a same-day run", () => {
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({ id: "user-1", role: "user", text: "A", at: localNoon(2026, 3, 17, 0) }),
        messageEntry({ id: "user-2", role: "user", text: "B", at: localNoon(2026, 3, 17, 5) }),
        messageEntry({ id: "user-3", role: "user", text: "C", at: localNoon(2026, 3, 19) }),
      ]),
    });

    const dividers = items.filter((item) => item.kind === "day-divider");
    expect(dividers).toHaveLength(2);
    expect(dividers[0]?.dayKey).not.toBe(dividers[1]?.dayKey);
    expect(items[0]?.kind).toBe("day-divider");
  });
});

describe("buildBubbleTimelineItems — sub-agent fold", () => {
  const deliveryOne = renderDelivery([
    {
      assignmentId: "asg_1",
      recipientBotId: "bot_7",
      instruction: "Audit the retry path.",
      summary: "Found one unbounded retry.",
    },
  ]);
  const deliveryTwo = renderDelivery([
    {
      assignmentId: "asg_2",
      recipientBotId: "bot_7",
      instruction: "Fix it.",
      summary: "Bounded it at five.",
    },
  ]);
  const deliveryOther = renderDelivery([
    {
      assignmentId: "asg_3",
      recipientBotId: "bot_9",
      instruction: "Review the fix.",
      summary: "Approved.",
    },
  ]);

  it("keeps a lone delivery as its own card — one finished assignment is news", () => {
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({
          id: "delivery-1",
          role: "user",
          text: deliveryOne,
          at: localNoon(2026, 3, 17),
        }),
      ]),
    });

    const card = items.find((item) => item.kind === "assignment-result");
    expect(card?.kind).toBe("assignment-result");
    expect(card?.kind === "assignment-result" && card.delivery.assignments[0]?.assignmentId).toBe(
      "asg_1",
    );
    expect(items.some((item) => item.kind === "attribution")).toBe(false);
  });

  it("folds consecutive deliveries into one roster-named attribution line", () => {
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({
          id: "delivery-1",
          role: "user",
          text: deliveryOne,
          at: localNoon(2026, 3, 17, 0),
        }),
        messageEntry({
          id: "delivery-2",
          role: "user",
          text: deliveryTwo,
          at: localNoon(2026, 3, 17, 1),
        }),
      ]),
      botNameById: new Map([["bot_7", "Code Monkey"]]),
    });

    const fold = items.find((item) => item.kind === "attribution");
    expect(fold?.kind === "attribution" && fold.label).toBe("2 messages with Code Monkey");
    expect(fold?.kind === "attribution" && fold.messageCount).toBe(2);
    expect(fold?.kind === "attribution" && fold.rows.map((row) => row.message.id)).toEqual([
      "delivery-1",
      "delivery-2",
    ]);
    expect(items.some((item) => item.kind === "assignment-result")).toBe(false);
  });

  it("deduplicates recipients in first-seen order and falls back to the bot id", () => {
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({
          id: "delivery-1",
          role: "user",
          text: deliveryOne,
          at: localNoon(2026, 3, 17, 0),
        }),
        messageEntry({
          id: "delivery-2",
          role: "user",
          text: deliveryOther,
          at: localNoon(2026, 3, 17, 1),
        }),
        messageEntry({
          id: "delivery-3",
          role: "user",
          text: deliveryTwo,
          at: localNoon(2026, 3, 17, 2),
        }),
      ]),
      botNameById: new Map([["bot_7", "Code Monkey"]]),
    });

    const fold = items.find((item) => item.kind === "attribution");
    expect(fold?.kind === "attribution" && fold.botIds).toEqual(["bot_7", "bot_9"]);
    // `bot_9` is not in the roster projection, so it keeps its id rather than
    // vanishing from the line.
    expect(fold?.kind === "attribution" && fold.label).toBe(
      "3 messages with Code Monkey and bot_9",
    );
  });

  it("stops folding at the first ordinary captain message", () => {
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({
          id: "delivery-1",
          role: "user",
          text: deliveryOne,
          at: localNoon(2026, 3, 17, 0),
        }),
        messageEntry({
          id: "delivery-2",
          role: "user",
          text: deliveryTwo,
          at: localNoon(2026, 3, 17, 1),
        }),
        messageEntry({
          id: "user-1",
          role: "user",
          text: "Nice",
          at: localNoon(2026, 3, 17, 2),
        }),
        messageEntry({
          id: "delivery-3",
          role: "user",
          text: deliveryOther,
          at: localNoon(2026, 3, 17, 3),
        }),
      ]),
    });

    expect(items.map((item) => item.kind)).toEqual([
      "day-divider",
      "attribution",
      "bubble",
      "assignment-result",
    ]);
  });

  it("does not repaint a captain message that merely looks like a delivery", () => {
    const items = buildBubbleTimelineItems({
      rows: rowsFrom([
        messageEntry({
          id: "user-1",
          role: "user",
          text: "An assignment you delegated has finished. (I think?)",
          at: localNoon(2026, 3, 17),
        }),
      ]),
    });

    expect(items.filter((item) => item.kind !== "day-divider").map((item) => item.kind)).toEqual([
      "bubble",
    ]);
  });
});

describe("resolveTraceCardSummary", () => {
  const createdAt = "2026-03-17T19:12:28.000Z";

  it("normalizes the compact tool label and counts the hidden entries", () => {
    const summary = resolveTraceCardSummary({
      kind: "work",
      id: "work-1",
      createdAt,
      groupedEntries: [
        { id: "e1", createdAt, label: "Ran command completed", tone: "tool" },
        { id: "e2", createdAt: "2026-03-17T19:12:30.500Z", label: "Read file", tone: "tool" },
      ],
    });

    expect(summary.label).toBe("Ran command");
    expect(summary.tone).toBe("tool");
    expect(summary.hiddenCount).toBe(1);
    expect(summary.durationMs).toBe(2_500);
  });

  it("prefers the tool title over the label when the entry carries one", () => {
    expect(
      resolveTraceCardSummary({
        kind: "work",
        id: "work-1",
        createdAt,
        groupedEntries: [
          { id: "e1", createdAt, label: "execute", toolTitle: "npm test complete", tone: "tool" },
        ],
      }).label,
    ).toBe("npm test");
  });

  it("sums a turn diff summary onto a message row", () => {
    const summary = resolveTraceCardSummary({
      kind: "message",
      id: "assistant-1",
      createdAt,
      message: {
        id: "assistant-1" as never,
        role: "assistant",
        text: "Done",
        turnId: "turn-1" as never,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
      durationStart: createdAt,
      showAssistantMeta: true,
      showAssistantCopyButton: true,
      assistantCopyStreaming: false,
      assistantTurnDiffSummary: {
        turnId: "turn-1" as never,
        completedAt: createdAt,
        assistantMessageId: "assistant-1" as never,
        checkpointTurnCount: 1,
        checkpointRef: "checkpoint-1" as never,
        status: "ready",
        files: [
          { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
          { path: "b.ts", kind: "added", additions: 9, deletions: 0 },
        ],
      } as never,
    });

    expect(summary.diffStat).toEqual({ additions: 12, deletions: 1 });
  });

  it("gives an unknown future row kind a card rather than a blank line", () => {
    const futureRow = { kind: "artifact-preview", id: "future-1", createdAt } as never;
    expect(resolveTraceCardSummary(futureRow)).toMatchObject({ label: "Activity", tone: "info" });
  });
});

describe("formatTraceDuration", () => {
  it("scales from milliseconds to minutes and stays silent when unknown", () => {
    expect(formatTraceDuration(null)).toBeNull();
    expect(formatTraceDuration(-1)).toBeNull();
    expect(formatTraceDuration(340)).toBe("340ms");
    expect(formatTraceDuration(1_240)).toBe("1.2s");
    expect(formatTraceDuration(125_000)).toBe("2m 05s");
  });
});

// ---------------------------------------------------------------------------
// Disclosure anchoring — expanding a card must not scroll the captain away
// ---------------------------------------------------------------------------

describe("disclosure anchoring", () => {
  it("anchors only the toggled row while a disclosure settles", () => {
    expect(shouldRestoreBubblePosition("trace-row-9", "trace-row-9")).toBe(true);
    expect(shouldRestoreBubblePosition("trace-row-9", "trace-row-2")).toBe(false);
    // Nothing in flight: ordinary "content above me grew" restoration.
    expect(shouldRestoreBubblePosition(null, "trace-row-2")).toBe(true);
  });

  it("uses the same anchor key the row model mints for a turn fold", () => {
    const rows = rowsFrom([
      messageEntry({ id: "u1", role: "user", text: "Ship it", at: localNoon(2026, 3, 17) }),
      workEntry({ id: "w1", label: "Ran command", at: localNoon(2026, 3, 17, 1) }),
      messageEntry({
        id: "a1",
        role: "assistant",
        text: "Done",
        at: localNoon(2026, 3, 17, 2),
        turnId: "turn-1",
      }),
    ]);
    const foldRow = rows.find((row) => row.kind === "turn-fold");
    if (foldRow === undefined || foldRow.kind !== "turn-fold") {
      throw new Error("fixture produced no turn-fold row");
    }
    // The anchor the messenger suspends on has to be the *item* id LegendList
    // will ask about; a trace item carries the row id verbatim.
    expect(resolveTurnFoldAnchorKey(foldRow.foldId)).toBe(foldRow.id);
    const items = buildBubbleTimelineItems({ rows });
    expect(items.some((item) => item.id === resolveTurnFoldAnchorKey(foldRow.foldId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Activity — an in-flight tool call must not render as a finished one
// ---------------------------------------------------------------------------

describe("resolveBubbleTimelineActivity", () => {
  it("reports a running turn as in progress and carries its id", () => {
    expect(
      resolveBubbleTimelineActivity({
        isWorking: true,
        latestTurn: { turnId: "turn-1" as never, state: "running" },
      }),
    ).toEqual({
      isWorking: true,
      activeTurnInProgress: true,
      latestTurnId: "turn-1",
      workingStepLabel: null,
    });
  });

  it("stops claiming progress once the turn settles, and keeps the turn id", () => {
    expect(
      resolveBubbleTimelineActivity({
        isWorking: false,
        latestTurn: { turnId: "turn-1" as never, state: "completed" },
      }),
    ).toEqual({
      isWorking: false,
      activeTurnInProgress: false,
      latestTurnId: "turn-1",
      workingStepLabel: null,
    });
  });

  it("has no turn to report before the first one", () => {
    expect(resolveBubbleTimelineActivity({ isWorking: false, latestTurn: null })).toEqual({
      isWorking: false,
      activeTurnInProgress: false,
      latestTurnId: null,
      workingStepLabel: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Bubble contents — attachments and send-time trailers
// ---------------------------------------------------------------------------

function bubbleRow(input: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image" | "file";
    readonly id: string;
    readonly name: string;
    readonly previewUrl?: string;
  }>;
}): Extract<MessagesTimelineRow, { kind: "message" }> {
  const at = localNoon(2026, 3, 17);
  return {
    kind: "message",
    id: "row-1",
    createdAt: at,
    message: {
      id: "message-1" as never,
      role: input.role,
      text: input.text,
      turnId: null as never,
      createdAt: at,
      updatedAt: at,
      streaming: false,
      ...(input.attachments ? { attachments: input.attachments as never } : {}),
    },
    durationStart: at,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  } as Extract<MessagesTimelineRow, { kind: "message" }>;
}

describe("resolveBubbleMessageDisplay", () => {
  it("renders an image-only captain message as content, not as an empty bubble", () => {
    const display = resolveBubbleMessageDisplay(
      bubbleRow({
        role: "user",
        text: "",
        attachments: [
          { type: "image", id: "img-1", name: "screenshot.png", previewUrl: "blob:one" },
        ],
      }),
    );

    expect(display.text).toBe("");
    expect(display.images.map((image) => image.id)).toEqual(["img-1"]);
    // The whole point: there is something to draw.
    expect(display.hasContent).toBe(true);
  });

  it("keeps file attachments and separates them from images", () => {
    const display = resolveBubbleMessageDisplay(
      bubbleRow({
        role: "user",
        text: "Have a look",
        attachments: [
          { type: "image", id: "img-1", name: "shot.png", previewUrl: "blob:one" },
          { type: "file", id: "file-1", name: "spec.pdf", previewUrl: "blob:two" },
        ],
      }),
    );

    expect(display.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(display.files.map((file) => file.id)).toEqual(["file-1"]);
  });

  it("strips send-time trailers from the bubble while the copy keeps them", () => {
    const raw =
      "Fix the retry path\n\n" +
      "<terminal_context>\n- Terminal 1 lines 1-2:\npnpm test\n</terminal_context>";
    const display = resolveBubbleMessageDisplay(bubbleRow({ role: "user", text: raw }));

    expect(display.text).toBe("Fix the retry path");
    expect(display.text).not.toContain("terminal_context");
    // Copying still yields exactly what was sent.
    expect(display.copyText).toBe(raw);
  });

  it("leaves a bot message alone — it carries no send-time trailers", () => {
    const display = resolveBubbleMessageDisplay(
      bubbleRow({ role: "assistant", text: "Fixed it in `retry.ts`." }),
    );

    expect(display.text).toBe("Fixed it in `retry.ts`.");
    expect(display.hasContent).toBe(true);
  });

  it("reports a message with neither text nor attachments as having nothing to draw", () => {
    expect(resolveBubbleMessageDisplay(bubbleRow({ role: "user", text: "   " })).hasContent).toBe(
      false,
    );
  });
});
