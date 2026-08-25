import type {
  AdeAssignmentGraph,
  AdeAssignmentGraphNode,
  Assignment,
  AssignmentId,
  BotId,
} from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getWorkGraphListRows,
  getWorkGraphTreeRows,
  NO_WORK_GRAPH_FILTER,
  workGraphIsFilteredEmpty,
  workGraphStatusCounts,
} from "./WorkGraph.logic";

function node(
  id: string,
  overrides: {
    readonly parent?: string | null;
    readonly bot?: string;
    readonly status?: Assignment["status"];
    readonly childCount?: number;
    readonly instruction?: string;
    readonly blockedReason?: Assignment["blockedReason"];
    readonly declaredRisk?: Assignment["declaredRisk"];
    readonly result?: Assignment["result"];
  } = {},
): AdeAssignmentGraphNode {
  return {
    assignment: {
      id,
      idempotencyKey: id,
      requester: { _tag: "captain" },
      recipientBotId: overrides.bot ?? "bot_1",
      projectId: "project_1",
      instruction: overrides.instruction ?? `Do ${id}`,
      declaredRisk: overrides.declaredRisk ?? "normal",
      parentAssignmentId: overrides.parent ?? null,
      status: overrides.status ?? "queued",
      blockedReason: overrides.blockedReason ?? null,
      queuePosition: 0,
      result: overrides.result ?? null,
      delivery: { delivered: false, deliveredAt: null },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
    botName: overrides.bot === "bot_2" ? "Coder" : "Second Mate",
    projectName: "Demo",
    childCount: overrides.childCount ?? 0,
  } as unknown as AdeAssignmentGraphNode;
}

function graph(nodes: ReadonlyArray<AdeAssignmentGraphNode>): AdeAssignmentGraph {
  return {
    nodes,
    bots: [
      { id: "bot_1", name: "Second Mate" },
      { id: "bot_2", name: "Coder" },
    ],
  } as unknown as AdeAssignmentGraph;
}

describe("getWorkGraphTreeRows", () => {
  it("nests children under their parent in pre-order", () => {
    const rows = getWorkGraphTreeRows(
      graph([
        node("root", { childCount: 2 }),
        node("child-a", { parent: "root", childCount: 1 }),
        node("grandchild", { parent: "child-a" }),
        node("child-b", { parent: "root" }),
      ]),
      NO_WORK_GRAPH_FILTER,
    );

    expect(rows.map((row) => [row.assignmentId, row.depth])).toEqual([
      ["root", 0],
      ["child-a", 1],
      ["grandchild", 2],
      ["child-b", 1],
    ]);
    expect(rows.every((row) => row.isContext === false)).toBe(true);
    expect(rows[0]?.hiddenChildCount).toBe(0);
  });

  it("roots a node whose parent is outside this scope instead of dropping it", () => {
    // The project-scoped graph is full of these: the captain-requested parent
    // may live on another project entirely.
    const rows = getWorkGraphTreeRows(
      graph([node("orphan", { parent: "elsewhere" }), node("child", { parent: "orphan" })]),
      NO_WORK_GRAPH_FILTER,
    );

    expect(rows.map((row) => [row.assignmentId, row.depth])).toEqual([
      ["orphan", 0],
      ["child", 1],
    ]);
  });

  it("reports children the graph is not drawing", () => {
    // Two children recorded, one inside this scope.
    const rows = getWorkGraphTreeRows(
      graph([node("root", { childCount: 2 }), node("child", { parent: "root" })]),
      NO_WORK_GRAPH_FILTER,
    );
    expect(rows[0]?.hiddenChildCount).toBe(1);
  });

  it("keeps a non-matching ancestor as context so the lineage stays whole", () => {
    const rows = getWorkGraphTreeRows(
      graph([
        node("root", { bot: "bot_1", childCount: 1 }),
        node("child", { parent: "root", bot: "bot_2" }),
      ]),
      { botId: "bot_2" as BotId, status: null },
    );

    expect(rows.map((row) => row.assignmentId)).toEqual(["root", "child"]);
    // The root only survives because its descendant matched.
    expect(rows[0]?.isContext).toBe(true);
    expect(rows[1]?.isContext).toBe(false);
  });

  it("prunes a branch where nothing matches", () => {
    const rows = getWorkGraphTreeRows(
      graph([
        node("root", { bot: "bot_1", childCount: 2 }),
        node("kept", { parent: "root", bot: "bot_2" }),
        node("pruned", { parent: "root", bot: "bot_1" }),
      ]),
      { botId: "bot_2" as BotId, status: null },
    );

    expect(rows.map((row) => row.assignmentId)).toEqual(["root", "kept"]);
    // One of the root's two children is now off screen.
    expect(rows[0]?.hiddenChildCount).toBe(1);
  });

  it("combines the bot and status filters", () => {
    const rows = getWorkGraphTreeRows(
      graph([
        node("a", { bot: "bot_2", status: "running" }),
        node("b", { bot: "bot_2", status: "completed" }),
        node("c", { bot: "bot_1", status: "running" }),
      ]),
      { botId: "bot_2" as BotId, status: "running" },
    );
    expect(rows.map((row) => row.assignmentId)).toEqual(["a"]);
  });

  it("terminates on a cycle in the recorded lineage", () => {
    // A pure view function must not be able to hang the page.
    const rows = getWorkGraphTreeRows(
      graph([node("a", { parent: "b" }), node("b", { parent: "a" })]),
      NO_WORK_GRAPH_FILTER,
    );
    expect(rows).toEqual([]);
  });

  it("reads nothing before the graph answers", () => {
    expect(getWorkGraphTreeRows(null, NO_WORK_GRAPH_FILTER)).toEqual([]);
  });
});

describe("getWorkGraphListRows", () => {
  it("shows matches only, flat, with no context rows", () => {
    const rows = getWorkGraphListRows(
      graph([
        node("root", { bot: "bot_1", childCount: 1 }),
        node("child", { parent: "root", bot: "bot_2" }),
      ]),
      { botId: "bot_2" as BotId, status: null },
    );

    expect(rows.map((row) => row.assignmentId)).toEqual(["child"]);
    expect(rows[0]?.depth).toBe(0);
    expect(rows[0]?.isContext).toBe(false);
  });

  it("names a blocked reason, an escalated risk, and a result summary", () => {
    const rows = getWorkGraphListRows(
      graph([
        node("a", {
          status: "blocked",
          blockedReason: "approval",
          declaredRisk: "protected",
        }),
        node("b", {
          status: "completed",
          result: {
            status: "completed",
            summary: "  Landed the panel.  ",
            artifacts: [],
          } as Assignment["result"],
        }),
      ]),
      NO_WORK_GRAPH_FILTER,
    );

    expect(rows[0]?.statusLabel).toBe("Blocked");
    expect(rows[0]?.statusTone).toBe("warning");
    expect(rows[0]?.blockedLabel).toBe("Waiting on approval");
    expect(rows[0]?.riskLabel).toBe("Protected");
    // A normal-risk row says nothing about risk.
    expect(rows[1]?.riskLabel).toBeNull();
    expect(rows[1]?.resultSummary).toBe("Landed the panel.");
  });
});

describe("work graph filters", () => {
  it("counts every status, including the ones holding nothing", () => {
    const counts = workGraphStatusCounts(
      graph([node("a", { status: "running" }), node("b", { status: "running" })]),
    );
    expect(counts.running).toBe(2);
    expect(counts.queued).toBe(0);
    expect(counts.cancelled).toBe(0);
  });

  it("tells a filtered-empty graph apart from a project with no work", () => {
    const populated = graph([node("a", { status: "running" })]);
    expect(workGraphIsFilteredEmpty(populated, [])).toBe(true);
    expect(workGraphIsFilteredEmpty(graph([]), [])).toBe(false);
    expect(workGraphIsFilteredEmpty(null, [])).toBe(false);
  });
});

describe("assignment lineage matches the engine's records", () => {
  it("keeps parentAssignmentId on every row so the tree can be re-derived", () => {
    const rows = getWorkGraphTreeRows(
      graph([node("root", { childCount: 1 }), node("child", { parent: "root" })]),
      NO_WORK_GRAPH_FILTER,
    );
    expect(rows[0]?.parentAssignmentId).toBeNull();
    expect(rows[1]?.parentAssignmentId).toBe("root" as AssignmentId);
  });
});
