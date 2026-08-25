import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AdeBotChatSession,
  AdeCaptainError,
  AdeCreateBotFromTemplateInput,
  AdeListNeedsYouInput,
  AdeProject,
  AdeRoster,
  AdeRosterEntry,
  AdeSubmitNeedsYouDecisionInput,
  ArtifactRef,
  Assignment,
  Bot,
  BotExecutionBinding,
  FleetHealthSnapshot,
  IntegrationCandidate,
  JjChangeId,
  LimitsConfig,
  MemoryDocument,
  NeedsYouItem,
  PersonaVersion,
  PublicationLayer,
  PublicationStack,
  ScreenboxProvisioning,
} from "./ade.ts";

const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, encoded: unknown) => {
  const decoded = Schema.decodeUnknownSync(schema)(encoded);
  const reEncoded = Schema.encodeUnknownSync(schema)(decoded);
  assert.deepEqual(reEncoded, encoded);
  return decoded;
};

const decodeBot = Schema.decodeUnknownSync(Bot);
const decodeMemoryDocument = Schema.decodeUnknownSync(MemoryDocument);
const decodeArtifactRef = Schema.decodeUnknownSync(ArtifactRef);
const decodeAssignment = Schema.decodeUnknownSync(Assignment);
const decodeLimitsConfig = Schema.decodeUnknownSync(LimitsConfig);
const decodeFleetHealthSnapshot = Schema.decodeUnknownSync(FleetHealthSnapshot);
const decodeAdeBotChatSession = Schema.decodeUnknownSync(AdeBotChatSession);

it("round-trips a Bot and defaults computerUse to false", () => {
  const bot = roundTrip(Bot, {
    id: "bot-firstmate",
    name: "Firstmate",
    displayMeta: { emoji: "🧭", color: "#224466", description: "Workspace coordinator" },
    structuralRole: "firstmate",
    roleTag: "Coordinator",
    projectId: null,
    activePersonaVersionId: "persona-1",
    computerUse: false,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
  });
  assert.strictEqual(bot.structuralRole, "firstmate");

  const defaulted = decodeBot({
    id: "bot-crew",
    name: "Coder",
    displayMeta: null,
    structuralRole: "crew",
    roleTag: "Coder",
    projectId: "project-1",
    activePersonaVersionId: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
  });
  assert.strictEqual(defaulted.computerUse, false);

  assert.throws(() =>
    decodeBot({
      id: "bot-x",
      name: "X",
      displayMeta: null,
      structuralRole: "captain",
      roleTag: "X",
      projectId: null,
      activePersonaVersionId: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      archivedAt: null,
    }),
  );
});

it("round-trips a PersonaVersion", () => {
  roundTrip(PersonaVersion, {
    id: "persona-1",
    botId: "bot-firstmate",
    content: "You are the Firstmate.",
    createdAt: "2026-08-24T00:00:00.000Z",
    activatedAt: "2026-08-24T00:05:00.000Z",
  });
});

it("round-trips a MemoryDocument and rejects unknown authors", () => {
  roundTrip(MemoryDocument, {
    botId: "bot-firstmate",
    content: "Prefers concise updates.",
    updatedAt: "2026-08-24T00:00:00.000Z",
    updatedBy: "captain",
  });
  assert.throws(() =>
    decodeMemoryDocument({
      botId: "bot-firstmate",
      content: "x",
      updatedAt: "2026-08-24T00:00:00.000Z",
      updatedBy: "other-bot",
    }),
  );
});

it("round-trips a BotExecutionBinding", () => {
  const binding = roundTrip(BotExecutionBinding, {
    id: "binding-1",
    botId: "bot-crew",
    engine: "shuvcode",
    sessionId: "sess-abc",
    purpose: "primary-text",
    status: "active",
    rolloverSummary: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
  assert.strictEqual(binding.engine, "shuvcode");
});

it("round-trips every ArtifactRef variant and rejects unknown tags", () => {
  const artifacts = [
    { _tag: "jjChange", changeId: "zkmqwpxr", projectId: "project-1" },
    { _tag: "publicationLayer", stackId: "stack-1", layerId: "layer-1" },
    { _tag: "file", path: "docs/report.md" },
    { _tag: "url", href: "https://example.com/run/1" },
  ];
  for (const artifact of artifacts) {
    roundTrip(ArtifactRef, artifact);
  }
  assert.throws(() => decodeArtifactRef({ _tag: "gitBranch", name: "main" }));
});

it("round-trips an Assignment with result and delivery record", () => {
  const assignment = roundTrip(Assignment, {
    id: "assignment-1",
    idempotencyKey: "toolcall-77",
    requester: { _tag: "bot", botId: "bot-secondmate" },
    recipientBotId: "bot-crew",
    projectId: "project-1",
    instruction: "Implement the widget",
    declaredRisk: "normal",
    parentAssignmentId: "assignment-0",
    status: "completed",
    blockedReason: null,
    queuePosition: 0,
    result: {
      status: "completed",
      summary: "Widget implemented",
      artifacts: [{ _tag: "jjChange", changeId: "zkmqwpxr", projectId: "project-1" }],
    },
    delivery: { delivered: true, deliveredAt: "2026-08-24T01:00:00.000Z" },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T01:00:00.000Z",
  });
  assert.strictEqual(assignment.requester._tag, "bot");

  roundTrip(Assignment, {
    id: "assignment-2",
    idempotencyKey: "captain-1",
    requester: { _tag: "captain" },
    recipientBotId: "bot-crew",
    projectId: null,
    instruction: "Investigate flaky boot",
    declaredRisk: "mechanical",
    parentAssignmentId: null,
    status: "blocked",
    blockedReason: "approval",
    queuePosition: 2,
    result: null,
    delivery: { delivered: false, deliveredAt: null },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
});

it("rejects an Assignment result summary over 16 KB", () => {
  assert.throws(() =>
    decodeAssignment({
      id: "assignment-3",
      idempotencyKey: "key-3",
      requester: { _tag: "captain" },
      recipientBotId: "bot-crew",
      projectId: null,
      instruction: "x",
      declaredRisk: "normal",
      parentAssignmentId: null,
      status: "completed",
      blockedReason: null,
      queuePosition: 0,
      result: { status: "completed", summary: "y".repeat(16_385), artifacts: [] },
      delivery: { delivered: false, deliveredAt: null },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    }),
  );
});

it("round-trips an AdeProject with both allow-list shapes", () => {
  roundTrip(AdeProject, {
    id: "project-1",
    name: "shuv2code",
    secondMateBotId: "bot-secondmate",
    repoBinding: { path: "/home/captain/repos/shuv2code", remote: "origin" },
    integrationPolicyDefault: "agent-review",
    checkCommands: ["vp check", "vp test run"],
    sharedSpecialistAllowList: "all",
    limitsOverrides: { maxQueuedAssignmentsPerBot: 5 },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
  const scoped = roundTrip(AdeProject, {
    id: "project-2",
    name: "notes",
    secondMateBotId: "bot-secondmate-2",
    repoBinding: null,
    integrationPolicyDefault: "automatic",
    checkCommands: [],
    sharedSpecialistAllowList: ["bot-researcher"],
    limitsOverrides: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
  assert.notStrictEqual(scoped.sharedSpecialistAllowList, "all");
  assert.strictEqual(scoped.sharedSpecialistAllowList[0], "bot-researcher");
});

it("round-trips an IntegrationCandidate", () => {
  roundTrip(IntegrationCandidate, {
    id: "candidate-1",
    projectId: "project-1",
    idempotencyKey: "assignment-1|assignment-2",
    sourceAssignmentIds: ["assignment-1", "assignment-2"],
    changeIds: ["zkmqwpxr", "qwlnnmts"],
    originatingBotId: "bot-coder",
    declaredRisk: "normal",
    status: "awaiting-review",
    gate: "agent-review",
    reviewerBotId: "bot-reviewer",
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
  });
});

it("round-trips a bounced IntegrationCandidate with its repair lineage", () => {
  const bounced = roundTrip(IntegrationCandidate, {
    id: "candidate-2",
    projectId: "project-1",
    idempotencyKey: "assignment-3",
    sourceAssignmentIds: ["assignment-3"],
    changeIds: ["zkmqwpxr"],
    originatingBotId: "bot-coder",
    declaredRisk: "protected",
    status: "bounced",
    gate: "human-approval",
    reviewerBotId: null,
    workspacePath: "/tmp/ade/project-1/candidate-2",
    verdict: "rejected",
    verdictAt: "2026-08-24T00:00:01.000Z",
    verdictByBotId: null,
    verdictDetail: "Not this release.",
    bounceCount: 1,
    bounce: {
      reason: "checks-failed",
      detail: "pnpm test exited 1",
      at: "2026-08-24T00:00:01.000Z",
    },
    repairAssignmentId: "assignment-4",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:01.000Z",
  });
  // The retained workspace is the forensic artifact (ADR §14.4).
  assert.strictEqual(bounced.workspacePath, "/tmp/ade/project-1/candidate-2");
  assert.strictEqual(bounced.bounce?.reason, "checks-failed");
});

it("round-trips a PublicationStack and PublicationLayer", () => {
  roundTrip(PublicationStack, {
    id: "stack-1",
    projectId: "project-1",
    mode: "native-stack",
    status: "review-frozen",
    stackUrl: "https://github.com/shuv1337/shuv2code/stacks/7",
    nativeStackNumber: 7,
    nativeStackNodeId: "ST_kwDO",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
  roundTrip(PublicationLayer, {
    id: "layer-1",
    stackId: "stack-1",
    order: 0,
    changeIds: ["zkmqwpxr"],
    bookmarkName: "ade/publish/stack-1/layer-1",
    prNumber: 158,
    headSha: "a".repeat(40),
    submittedSha: "b".repeat(40),
    mergeSha: null,
    prState: "open",
    status: "submitted",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  });
});

it("round-trips a ScreenboxProvisioning record", () => {
  roundTrip(ScreenboxProvisioning, {
    botId: "bot-crew",
    status: "running",
    containerRef: "screenbox-bot-crew",
    volumeRef: "vol-bot-crew",
    createdAt: "2026-08-24T00:00:00.000Z",
    lastNeededAt: "2026-08-24T02:00:00.000Z",
  });
});

it("round-trips a NeedsYouItem with mixed subject refs", () => {
  roundTrip(NeedsYouItem, {
    id: "needsyou-1",
    kind: "kernel-down",
    subjectRefs: [
      { _tag: "kernel", engine: "codex" },
      { _tag: "assignment", assignmentId: "assignment-1" },
    ],
    status: "open",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    resolvedAt: null,
  });
});

it("decodes LimitsConfig defaults from an empty object (ADR §18.1 seed)", () => {
  const limits = decodeLimitsConfig({});
  assert.deepEqual(limits, {
    maxBots: 24,
    maxConcurrentAssignments: 16,
    maxParallelSessionsPerBot: 3,
    maxDelegationDepth: 5,
    maxQueuedAssignmentsPerBot: 20,
    maxResultSummaryLength: 16_384,
    maxConcurrentScreenboxDesktops: 4,
    screenboxIdleStopMinutes: 30,
    integrationWorkspaceRetentionDays: 7,
  });
});

it("round-trips an explicit LimitsConfig", () => {
  roundTrip(LimitsConfig, {
    maxBots: 10,
    maxConcurrentAssignments: 4,
    maxParallelSessionsPerBot: 1,
    maxDelegationDepth: 2,
    maxQueuedAssignmentsPerBot: 3,
    maxResultSummaryLength: 1_024,
    maxConcurrentScreenboxDesktops: 1,
    screenboxIdleStopMinutes: 5,
    integrationWorkspaceRetentionDays: 30,
  });
});

it("round-trips a FleetHealthSnapshot across all pill states", () => {
  const snapshot = roundTrip(FleetHealthSnapshot, {
    targets: [
      {
        target: "shuvcode",
        state: "healthy",
        detail: null,
        since: "2026-08-24T00:00:00.000Z",
        checkedAt: "2026-08-24T00:05:00.000Z",
      },
      {
        target: "codex",
        state: "down",
        detail: "codex app-server exited (2 consecutive failures)",
        since: "2026-08-24T00:04:00.000Z",
        checkedAt: "2026-08-24T00:05:00.000Z",
      },
      {
        target: "screenbox",
        state: "not-provisioned",
        detail: "Screenbox runtime is not provisioned",
        since: "2026-08-24T00:00:00.000Z",
        checkedAt: "2026-08-24T00:05:00.000Z",
      },
    ],
  });
  assert.lengthOf(snapshot.targets, 3);
  assert.strictEqual(snapshot.targets[1]!.state, "down");
});

it("rejects an unknown health target", () => {
  assert.throws(() =>
    decodeFleetHealthSnapshot({
      targets: [
        {
          target: "warp-core",
          state: "healthy",
          detail: null,
          since: "2026-08-24T00:00:00.000Z",
          checkedAt: "2026-08-24T00:00:00.000Z",
        },
      ],
    }),
  );
});

// ---------------------------------------------------------------------------
// Captain surface views (spec §7 slices 1, 2, 8)
// ---------------------------------------------------------------------------

const decodeAdeCreateBotFromTemplateInput = Schema.decodeUnknownSync(AdeCreateBotFromTemplateInput);

it("round-trips a roster with a pinned Firstmate and its crew templates", () => {
  const roster = roundTrip(AdeRoster, {
    entries: [
      {
        bot: {
          id: "bot-firstmate",
          name: "Firstmate",
          displayMeta: null,
          structuralRole: "firstmate",
          roleTag: "Coordinator",
          projectId: null,
          activePersonaVersionId: "persona-1",
          computerUse: false,
          createdAt: "2026-08-24T00:00:00.000Z",
          archivedAt: null,
        },
        projectName: null,
        hasActivePrimarySession: true,
        openAssignmentCount: 2,
      },
    ],
    projects: [{ id: "project-1", name: "shuv2code" }],
    templates: [{ templateId: "coder", defaultName: "Coder", roleTag: "Coder" }],
  });
  assert.strictEqual(roster.entries[0]!.bot.structuralRole, "firstmate");
  assert.strictEqual(roster.entries[0]!.openAssignmentCount, 2);
  assert.strictEqual(roster.templates[0]!.templateId, "coder");
});

it("rejects a negative open-assignment count", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(AdeRosterEntry)({
      bot: {
        id: "bot-1",
        name: "Coder",
        displayMeta: null,
        structuralRole: "crew",
        roleTag: "Coder",
        projectId: null,
        activePersonaVersionId: null,
        computerUse: false,
        createdAt: "2026-08-24T00:00:00.000Z",
        archivedAt: null,
      },
      projectName: null,
      hasActivePrimarySession: false,
      openAssignmentCount: -1,
    }),
  );
});

it("round-trips a chat session binding a thread to a kernel session", () => {
  const session = roundTrip(AdeBotChatSession, {
    botId: "bot-firstmate",
    threadId: "ade-bot-bot-firstmate",
    engine: "shuvcode",
    bindingId: "binding-1",
    sessionId: "oc-session-1",
    startedNow: true,
    toolsProbe: "attached",
    toolsAttached: true,
  });
  assert.strictEqual(session.engine, "shuvcode");
});

it("defaults the tool probe for a payload minted before the tri-state existed", () => {
  // An older peer only knows the boolean. Decoding must not invent a
  // "missing", because that is the false negative issue #199 was.
  const session = decodeAdeBotChatSession({
    botId: "bot-firstmate",
    threadId: "ade-bot-bot-firstmate",
    engine: "shuvcode",
    bindingId: "binding-1",
    sessionId: "oc-session-1",
    startedNow: false,
  });
  assert.strictEqual(session.toolsProbe, "attached");
  assert.isTrue(session.toolsAttached);
});

it("offers only the one-click crew templates, never a coordinator", () => {
  assert.strictEqual(
    decodeAdeCreateBotFromTemplateInput({ templateId: "reviewer", projectId: null }).templateId,
    "reviewer",
  );
  // The Firstmate comes from the boot check and a Second Mate from project
  // creation; neither is instantiable from the roster (spec §4.1).
  assert.throws(() =>
    decodeAdeCreateBotFromTemplateInput({ templateId: "firstmate", projectId: null }),
  );
  assert.throws(() =>
    decodeAdeCreateBotFromTemplateInput({ templateId: "second-mate", projectId: null }),
  );
});

it("carries a closed reason union on the captain error", () => {
  const decode = Schema.decodeUnknownSync(AdeCaptainError);
  const error = decode({
    _tag: "AdeCaptainError",
    reason: "memory_conflict",
    message: "Memory document changed.",
  });
  assert.strictEqual(error.reason, "memory_conflict");
  assert.throws(() => decode({ _tag: "AdeCaptainError", reason: "teapot", message: "nope" }));
});

it("defaults the Needs You inbox to open items and closes the decision union", () => {
  // The inbox is what a badge sends you to; defaulting to the whole history
  // would answer a different question than the one the badge asked.
  const decodeList = Schema.decodeUnknownSync(AdeListNeedsYouInput);
  assert.deepStrictEqual(decodeList({}), { includeResolved: false });
  assert.deepStrictEqual(decodeList({ includeResolved: true }), { includeResolved: true });

  const decodeDecision = Schema.decodeUnknownSync(AdeSubmitNeedsYouDecisionInput);
  for (const decision of ["approve", "deny", "acknowledge"] as const) {
    assert.strictEqual(decodeDecision({ needsYouItemId: "item-1", decision }).decision, decision);
  }
  // No "dismiss" or "snooze": two verdicts that move work, and one that clears
  // a notice nothing else can clear.
  assert.throws(() => decodeDecision({ needsYouItemId: "item-1", decision: "maybe" }));
});

it("refuses a change id that is a revset or a flag", () => {
  // JjChangeId feeds `jj` arguments, so the alphabet is the first line of
  // defense against revset/flag injection from bot tool calls.
  const decodeChangeId = Schema.decodeUnknownSync(JjChangeId);
  assert.strictEqual(decodeChangeId("zkmqwpxr"), "zkmqwpxr");
  for (const hostile of [
    "all()",
    "root()",
    "--help",
    "zkmqwpxr | all()",
    "abc",
    "ZKMQWPXR",
    "a1b2",
  ]) {
    assert.throws(() => decodeChangeId(hostile));
  }
});
